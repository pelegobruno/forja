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

const DB_FILE = path.join(__dirname, 'agendamentos.json');
const AUTH_DIR = path.join(__dirname, 'auth_baileys');

const sessoes = {};
let statusAtualBot = 'iniciando';
let ultimoQrAtual = null;
let reconexaoAgendada = false;

if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2), 'utf8');
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

function renderizarPaginaQrHtml(qrDataUrl) {
    const conectado = estaConectado();
    const rotuloStatus = conectado ? 'Conectado' : 'Desconectado';

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WhatsApp QR Code</title>
  <style>
    * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #090d16;
      color: #f8fafc;
      padding: 20px;
    }
    .box {
      width: 100%;
      max-width: 340px;
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 18px;
      padding: 28px 24px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5);
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 14px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.2px;
      background: ${conectado ? 'rgba(16, 185, 129, 0.14)' : 'rgba(239, 68, 68, 0.14)'};
      color: ${conectado ? '#34d399' : '#f87171'};
      border: 1px solid ${conectado ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)'};
    }
    .status.online {
      background: rgba(16, 185, 129, 0.14);
      color: #34d399;
      border-color: rgba(16, 185, 129, 0.35);
    }
    .status.offline {
      background: rgba(239, 68, 68, 0.14);
      color: #f87171;
      border-color: rgba(239, 68, 68, 0.35);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
    }
    .qr-wrap {
      background: #ffffff;
      padding: 14px;
      border-radius: 14px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }
    .qr-wrap img {
      display: block;
      width: 228px;
      height: 228px;
    }
    .btn {
      width: 100%;
      padding: 11px 18px;
      border: none;
      border-radius: 10px;
      background: #2563eb;
      color: #ffffff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .btn:hover { background: #1d4ed8; }
    .btn:active { transform: translateY(1px); }
  </style>
</head>
<body>
  <div class="box">
    <div id="statusBadge" class="status ${conectado ? 'online' : 'offline'}">
      <span class="dot"></span>
      <span id="statusTexto">${rotuloStatus}</span>
    </div>
    <div id="qrArea">${qrDataUrl ? `<div class="qr-wrap"><img id="qrImg" src="${qrDataUrl}" alt="QR Code" /></div>` : ''}</div>
    <button id="btnAtualizar" class="btn" type="button">Atualizar</button>
  </div>

  <script>
    let ultimoQrRenderizado = ${JSON.stringify(qrDataUrl || '')};
    let ultimoConectadoRenderizado = ${JSON.stringify(conectado)};

    async function sincronizarEstado() {
      try {
        const resp = await fetch('/api/status', { cache: 'no-store' });
        if (!resp.ok) return;
        const data = await resp.json();
        const conectadoAgora = Boolean(data.conectado);
        const qrAgora = data.qrDataUrl || '';

        if (conectadoAgora !== ultimoConectadoRenderizado) {
          ultimoConectadoRenderizado = conectadoAgora;
          const badge = document.getElementById('statusBadge');
          const texto = document.getElementById('statusTexto');
          badge.className = 'status ' + (conectadoAgora ? 'online' : 'offline');
          texto.textContent = conectadoAgora ? 'Conectado' : 'Desconectado';
        }

        if (qrAgora !== ultimoQrRenderizado) {
          ultimoQrRenderizado = qrAgora;
          const qrArea = document.getElementById('qrArea');
          qrArea.innerHTML = qrAgora
            ? '<div class="qr-wrap"><img id="qrImg" src="' + qrAgora + '" alt="QR Code" /></div>'
            : '';
        }
      } catch (_) {}
    }

    document.getElementById('btnAtualizar').addEventListener('click', sincronizarEstado);
    setInterval(sincronizarEstado, 2000);
  </script>
</body>
</html>`;
}

function iniciarAutoPing() {
    const urlBase = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
    if (!urlBase) return;

    const destino = `${urlBase.replace(/\/+$/, '')}/api/status`;
    const cliente = destino.startsWith('https://') ? https : http;

    setInterval(() => {
        try {
            cliente.get(destino, (res) => {
                res.resume();
            }).on('error', () => {});
        } catch (_) {}
    }, 8 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
http.createServer(async (req, res) => {
    const rota = (req.url || '/').split('?')[0];

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
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ erro: 'Falha ao obter estado' }));
        }
        return;
    }

    if (rota === '/' || rota === '/qr') {
        try {
            const qrDataUrl = ultimoQrAtual ? await QRCode.toDataURL(ultimoQrAtual) : null;
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(renderizarPaginaQrHtml(qrDataUrl));
        } catch (e) {
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

async function iniciarBot() {
    reconexaoAgendada = false;
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
        await saveCreds(state.creds);
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

            const deveReconectar = !deslogado;
            statusAtualBot = deveReconectar ? 'reconectando' : 'desconectado';
            ultimoQrAtual = null;
            await atualizarStatusBot(statusAtualBot, null);
            console.log('Conexao encerrada. Codigo:', statusCode, '| Reconectando:', deveReconectar);

            if (deveReconectar && !reconexaoAgendada) {
                reconexaoAgendada = true;
                setTimeout(iniciarBot, 2500);
            } else if (deslogado && !reconexaoAgendada) {
                reconexaoAgendada = true;
                setTimeout(iniciarBot, 2500);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`[EVENTO] messages.upsert (${type}) - qtd: ${messages.length}`);

        for (const msg of messages) {
            if (!msg.message) continue;

            const chatId = msg.key.remoteJid;
            if (!chatId || chatId.endsWith('@g.us') || chatId === 'status@broadcast') continue;

            if (msg.key.fromMe) {
                console.log(`[IGNORADO] Mensagem propria (fromMe=true) em ${chatId}`);
                continue;
            }

            const textoOriginal = extrairTexto(msg);
            console.log(`[RECEBIDO] De: ${chatId} | Texto: "${textoOriginal}"`);
            if (!textoOriginal) continue;

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
            await registrarNaMemoria(chatId, 'cliente', textoOriginal);

            const respostaTexto = await responderHumanizado(
                chatId,
                textoOriginal,
                sessao,
                salvarRegistro
            );

            if (respostaTexto) {
                await registrarNaMemoria(chatId, 'secretaria', respostaTexto);
                await sock.sendMessage(chatId, { text: respostaTexto });
                console.log(`[ENVIADO] Para: ${chatId}`);
            }
        }
    });
}

iniciarBot();