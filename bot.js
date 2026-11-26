const {
    default: makeWASocket,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { admin, getDb, isFirestoreAtivo } = require('./firebase');
const { useFirestoreAuthState, limparSessaoFirestore } = require('./authFirestore');
const {
    carregarMemoriaContato,
    registrarNaMemoria,
    responderHumanizado
} = require('./compreensao');
const {
    resumirParaSuperior,
    registrarParecerSuperior,
    refinarRespostaChefe
} = require('./chefeEspecialista');
const {
    renderizarPaginaQrHtml,
    tratarRotaAdmin
} = require('./adminPainel');

const DB_FILE = path.join(__dirname, 'agendamentos.json');
const CONTATOS_FILE = path.join(__dirname, 'contatos.json');
const AUTH_DIR = path.join(__dirname, 'auth_baileys');
const JANELA_AGRUPAMENTO_MS = 1400;

const sessoes = {};
const idsProcessados = new Set();
const filaAgrupamento = new Map();

let statusAtualBot = 'iniciando';
let ultimoQrAtual = null;
let reconexaoTimer = null;

if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2), 'utf8');
}
if (!fs.existsSync(CONTATOS_FILE)) {
    fs.writeFileSync(CONTATOS_FILE, JSON.stringify([], null, 2), 'utf8');
}

function marcarIdProcessado(msgId) {
    if (!msgId) return false;
    if (idsProcessados.has(msgId)) return true;
    idsProcessados.add(msgId);
    if (idsProcessados.size > 400) {
        const primeiro = idsProcessados.values().next().value;
        idsProcessados.delete(primeiro);
    }
    return false;
}

async function registrarContato(chatId, { nomePush, textoRecebido, nomeTriagem } = {}) {
    if (!chatId) return;
    const agoraMs = Date.now();
    const agoraTexto = new Date(agoraMs).toLocaleString('pt-BR');
    const telefone = chatId.split('@')[0];
    const docId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');

    let listaLocal = [];
    try {
        const raw = fs.readFileSync(CONTATOS_FILE, 'utf8');
        if (raw.trim()) listaLocal = JSON.parse(raw);
    } catch (_) {
        listaLocal = [];
    }

    const idx = listaLocal.findIndex((c) => c.chatId === chatId);
    const anterior = idx >= 0 ? listaLocal[idx] : null;
    const nomeDefinido =
        nomeTriagem ||
        nomePush ||
        (anterior && anterior.nome && anterior.nome !== 'Sem nome' ? anterior.nome : 'Sem nome');

    const registro = {
        id: docId,
        chatId,
        telefone,
        nome: nomeDefinido,
        primeiraMensagem: anterior?.primeiraMensagem || textoRecebido || '',
        ultimaMensagem: textoRecebido || anterior?.ultimaMensagem || '',
        totalMensagens: (anterior?.totalMensagens || 0) + (textoRecebido ? 1 : 0),
        criadoEmMs: anterior?.criadoEmMs || agoraMs,
        criadoEmTexto: anterior?.criadoEmTexto || agoraTexto,
        ultimaInteracaoEm: agoraMs,
        ultimaInteracaoTexto: agoraTexto
    };

    if (idx >= 0) listaLocal[idx] = registro;
    else listaLocal.push(registro);

    try {
        fs.writeFileSync(CONTATOS_FILE, JSON.stringify(listaLocal, null, 2), 'utf8');
    } catch (e) {
        console.error('Erro ao salvar contato local:', e.message);
    }

    const db = getDb();
    if (db) {
        try {
            await db.collection('contatos').doc(docId).set(
                {
                    ...registro,
                    atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
                },
                { merge: true }
            );
        } catch (e) {
            console.error('Erro ao salvar contato no Firestore:', e.message);
        }
    }
}

async function atualizarStatusBot(status, qrString = null) {
    statusAtualBot = status;
    ultimoQrAtual = qrString;

    const db = getDb();
    if (!db) return;

    try {
        await db.collection('bot_status').doc('whatsapp').set(
            {
                status,
                qr: qrString,
                atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
                atualizadoEmTexto: new Date().toLocaleString('pt-BR')
            },
            { merge: true }
        );
    } catch (e) {
        console.error('Erro ao atualizar bot_status no Firestore:', e.message);
    }
}

async function salvarRegistro(novoDado) {
    const idGerado = String(Date.now());
    const dataRegistro = new Date().toLocaleString('pt-BR');

    const registroCompleto = {
        ...novoDado,
        id: idGerado,
        dataRegistro
    };

    try {
        let registros = [];
        if (fs.existsSync(DB_FILE)) {
            const conteudo = fs.readFileSync(DB_FILE, 'utf8');
            if (conteudo.trim() !== '') registros = JSON.parse(conteudo);
        }
        registros.push(registroCompleto);
        fs.writeFileSync(DB_FILE, JSON.stringify(registros, null, 2), 'utf8');
    } catch (e) {
        console.error('Erro ao salvar backup local:', e.message);
    }

    if (novoDado.chatId && novoDado.nome) {
        await registrarContato(novoDado.chatId, { nomeTriagem: novoDado.nome });
    }

    const db = getDb();
    if (db) {
        try {
            await db.collection('agendamentos').doc(idGerado).set({
                ...registroCompleto,
                criadoEm: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`Triagem salva no Firestore (agendamentos/${idGerado})`);
        } catch (e) {
            console.error('Erro ao salvar agendamento no Firestore:', e.message);
        }
    }
}

function extrairTexto(msg) {
    if (!msg.message) return '';
    const conteudo = msg.message.ephemeralMessage?.message || msg.message;
    return (
        conteudo.conversation ||
        conteudo.extendedTextMessage?.text ||
        conteudo.buttonsResponseMessage?.selectedButtonId ||
        conteudo.listResponseMessage?.singleSelectReply?.selectedRowId ||
        ''
    ).trim();
}

function estaConectado() {
    return statusAtualBot === 'online' && !ultimoQrAtual;
}

function lerCorpoJson(req) {
    return new Promise((resolve, reject) => {
        let bruto = '';
        req.on('data', (chunk) => {
            bruto += chunk.toString('utf8');
            if (bruto.length > 100000) reject(new Error('Payload muito grande'));
        });
        req.on('end', () => {
            try {
                resolve(bruto ? JSON.parse(bruto) : {});
            } catch (_) {
                reject(new Error('JSON invalido'));
            }
        });
        req.on('error', reject);
    });
}

function iniciarAutoPing() {
    const urlBase = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
    if (!urlBase) return;

    const destino = `${urlBase.replace(/\/+$/, '')}/api/status`;
    const cliente = destino.startsWith('https://') ? https : http;

    setInterval(() => {
        try {
            cliente.get(destino, (res) => res.resume()).on('error', () => {});
        } catch (_) {}
    }, 8 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
http.createServer(async (req, res) => {
    const urlCompleta = new URL(req.url || '/', `http://localhost:${PORT}`);
    const rota = urlCompleta.pathname;

    if (rota === '/api/status' || rota === '/status' || rota === '/health') {
        try {
            const qrDataUrl = ultimoQrAtual ? await QRCode.toDataURL(ultimoQrAtual) : null;
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(JSON.stringify({
                conectado: estaConectado(),
                status: statusAtualBot,
                qrDataUrl,
                atualizadoEm: new Date().toLocaleString('pt-BR')
            }));
        } catch (_) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ erro: 'Falha ao obter estado' }));
        }
        return;
    }

    const tratadoPeloAdmin = await tratarRotaAdmin(req, res, rota, urlCompleta, {
        dbFile: DB_FILE,
        contatosFile: CONTATOS_FILE,
        getDb,
        estaConectado,
        statusAtualBot,
        lerCorpoJson,
        onReset: () => {
            Object.keys(sessoes).forEach((k) => delete sessoes[k]);
            idsProcessados.clear();
            filaAgrupamento.clear();
        }
    });
    if (tratadoPeloAdmin) return;

    if (rota === '/' || rota === '/qr') {
        try {
            const qrDataUrl = ultimoQrAtual ? await QRCode.toDataURL(ultimoQrAtual) : null;
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(renderizarPaginaQrHtml(qrDataUrl, estaConectado()));
        } catch (_) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Erro ao gerar QR Code');
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Nao encontrado');
}).listen(PORT, () => {
    console.log(`Servidor HTTP ativo na porta ${PORT} (QR em /qr e estado em /api/status)`);
    iniciarAutoPing();
});

function agendarReconexao(delayMs = 3000) {
    if (reconexaoTimer) clearTimeout(reconexaoTimer);
    reconexaoTimer = setTimeout(() => {
        reconexaoTimer = null;
        iniciarBot().catch((err) => {
            console.error('[ERRO iniciarBot]', err.message);
            agendarReconexao(5000);
        });
    }, delayMs);
}

async function processarLoteMensagens(sock, chatId, textos, nomePush = '') {
    const textoConsolidado = textos.join('\n').trim();
    if (!textoConsolidado) return;

    await registrarContato(chatId, {
        nomePush,
        textoRecebido: textoConsolidado
    });

    const mem = await carregarMemoriaContato(chatId);

    if (!sessoes[chatId]) {
        sessoes[chatId] = {
            etapa: mem.fluxoAtual || 'MENU',
            dados: mem.fluxoAtual && mem.fluxoAtual !== 'MENU'
                ? { tipo: mem.fluxoAtual.replace('_ANDAMENTO', '') }
                : {}
        };
    }

    const sessao = sessoes[chatId];
    await registrarNaMemoria(chatId, 'cliente', textoConsolidado);

    const respostaBruta = await responderHumanizado(
        chatId,
        textoConsolidado,
        sessao,
        salvarRegistro
    );

    const respostaFinal = refinarRespostaChefe({
        respostaBase: respostaBruta,
        mem,
        sessao,
        textoAgrupado: textoConsolidado
    });

    if (respostaFinal) {
        await registrarNaMemoria(chatId, 'secretaria', respostaFinal);
        await sock.sendMessage(chatId, { text: respostaFinal });

        const parecer = resumirParaSuperior({
            chatId,
            textoRecebido: textoConsolidado,
            respostaSecretaria: respostaFinal,
            sessao,
            mem
        });
        await registrarParecerSuperior(parecer);
        console.log(`[ENVIADO] Para: ${chatId} | Chefe (${parecer.prioridade}): ${parecer.acaoSugerida}`);
    } else {
        console.log(`[SEM RESPOSTA] responderHumanizado retornou vazio para ${chatId}`);
    }
}

function enfileirarMensagem(sock, chatId, textoOriginal, nomePush = '') {
    const atual = filaAgrupamento.get(chatId) || { textos: [], nomePush: '', timer: null };
    atual.textos.push(textoOriginal);
    if (nomePush) atual.nomePush = nomePush;
    if (atual.timer) clearTimeout(atual.timer);

    atual.timer = setTimeout(async () => {
        filaAgrupamento.delete(chatId);
        try {
            await processarLoteMensagens(sock, chatId, atual.textos, atual.nomePush);
        } catch (err) {
            console.error('[ERRO processarLoteMensagens]', err.message);
        }
    }, JANELA_AGRUPAMENTO_MS);

    filaAgrupamento.set(chatId, atual);
}

async function iniciarBot() {
    if (reconexaoTimer) {
        clearTimeout(reconexaoTimer);
        reconexaoTimer = null;
    }

    console.log(
        isFirestoreAtivo()
            ? 'Firestore conectado (projeto clinica-forja)!'
            : 'Aviso: Firestore inativo (verifique .env). Usando backup local.'
    );

    const { state, saveCreds } = await useFirestoreAuthState(AUTH_DIR);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Instituto Forja', 'Chrome', '1.0.0'],
        syncFullHistory: false
    });

    sock.ev.on('creds.update', async () => {
        try {
            await saveCreds(state.creds);
        } catch (e) {
            console.error('[ERRO creds.update]', e.message);
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            await atualizarStatusBot('qr_pendente', qr);
            console.log('\n=================================================');
            console.log('ESCANEIE O QR CODE EM /qr NO NAVEGADOR OU ABAIXO:');
            console.log('=================================================\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            statusAtualBot = 'online';
            ultimoQrAtual = null;
            await saveCreds(state.creds);
            await atualizarStatusBot('online', null);
            console.log('Secretaria virtual do Instituto Forja ONLINE e pronta para responder!');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const deslogado = statusCode === DisconnectReason.loggedOut;

            if (deslogado) {
                await limparSessaoFirestore(AUTH_DIR);
            }

            statusAtualBot = deslogado ? 'desconectado' : 'reconectando';
            ultimoQrAtual = null;
            await atualizarStatusBot(statusAtualBot, null);
            console.log('Conexao encerrada. Codigo:', statusCode, '| Deslogado:', deslogado);

            agendarReconexao(deslogado ? 4000 : 2500);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`[EVENTO] messages.upsert (${type}) - qtd: ${messages.length}`);

        for (const msg of messages) {
            try {
                if (!msg.message) continue;

                const chatId = msg.key.remoteJid;
                if (!chatId || chatId.endsWith('@g.us') || chatId === 'status@broadcast') continue;

                if (msg.key.fromMe) {
                    console.log(`[IGNORADO] Mensagem propria (fromMe=true) em ${chatId}`);
                    continue;
                }

                if (marcarIdProcessado(msg.key.id)) {
                    console.log(`[DUPLICADA IGNORADA] id=${msg.key.id} em ${chatId}`);
                    continue;
                }

                const textoOriginal = extrairTexto(msg);
                const nomePush = (msg.pushName || '').trim();
                console.log(`[RECEBIDO] De: ${chatId} | Texto: "${textoOriginal}"`);
                if (!textoOriginal) continue;

                enfileirarMensagem(sock, chatId, textoOriginal, nomePush);
            } catch (err) {
                console.error('[ERRO processarMensagem]', err.message);
            }
        }
    });
}

iniciarBot().catch((err) => {
    console.error('[ERRO fatal iniciarBot]', err.message);
    agendarReconexao(4000);
});