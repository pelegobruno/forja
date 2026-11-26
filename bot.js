const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { admin, getDb, isFirestoreAtivo } = require('./firebase');

const DB_FILE = path.join(__dirname, 'agendamentos.json');
const MEMORIA_FILE = path.join(__dirname, 'memorias_conversas.json');
const AUTH_DIR = path.join(__dirname, 'auth_baileys');

const sessoes = {};
let memoriasSalvas = {};
let statusAtualBot = 'iniciando';
let ultimoQrAtual = null;

if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2), 'utf8');
}

if (fs.existsSync(MEMORIA_FILE)) {
    try {
        const bruto = fs.readFileSync(MEMORIA_FILE, 'utf8');
        if (bruto.trim() !== '') {
            const parsed = JSON.parse(bruto);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                memoriasSalvas = parsed;
            }
        }
    } catch (e) {
        console.error('Erro ao ler memorias_conversas.json:', e);
    }
} else {
    fs.writeFileSync(MEMORIA_FILE, JSON.stringify({}, null, 2), 'utf8');
}

function persistirMemoriasLocal() {
    try {
        fs.writeFileSync(MEMORIA_FILE, JSON.stringify(memoriasSalvas, null, 2), 'utf8');
    } catch (e) {
        console.error('Erro ao salvar memorias_conversas.json:', e);
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

function docIdSeguro(chatId) {
    return chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function normalizarEstruturaMemoria(dados = {}, agoraTexto = new Date().toLocaleString('pt-BR')) {
    const base = dados && typeof dados === 'object' ? dados : {};
    return {
        criadoEm: typeof base.criadoEm === 'string' && base.criadoEm ? base.criadoEm : agoraTexto,
        atualizadoEm: typeof base.atualizadoEm === 'string' && base.atualizadoEm ? base.atualizadoEm : agoraTexto,
        fluxoAtual: typeof base.fluxoAtual === 'string' && base.fluxoAtual ? base.fluxoAtual : 'MENU',
        nomeIdentificado: typeof base.nomeIdentificado === 'string' ? base.nomeIdentificado : null,
        temasVistos: Array.isArray(base.temasVistos) ? base.temasVistos : [],
        mensagens: Array.isArray(base.mensagens) ? base.mensagens : []
    };
}

async function carregarMemoriaContato(chatId) {
    if (memoriasSalvas[chatId]) {
        memoriasSalvas[chatId] = normalizarEstruturaMemoria(memoriasSalvas[chatId]);
        return memoriasSalvas[chatId];
    }

    const db = getDb();
    if (db) {
        try {
            const snap = await db.collection('conversas').doc(docIdSeguro(chatId)).get();
            if (snap.exists) {
                memoriasSalvas[chatId] = normalizarEstruturaMemoria(snap.data());
                persistirMemoriasLocal();
                return memoriasSalvas[chatId];
            }
        } catch (e) {
            console.error('Erro ao buscar conversa no Firestore:', e.message);
        }
    }

    memoriasSalvas[chatId] = normalizarEstruturaMemoria();
    return memoriasSalvas[chatId];
}

async function salvarMemoriaContato(chatId) {
    const mem = normalizarEstruturaMemoria(memoriasSalvas[chatId]);
    memoriasSalvas[chatId] = mem;
    persistirMemoriasLocal();

    const db = getDb();
    if (db) {
        try {
            await db.collection('conversas').doc(docIdSeguro(chatId)).set(
                {
                    chatId,
                    ...mem,
                    atualizadoTimestamp: admin.firestore.FieldValue.serverTimestamp()
                },
                { merge: true }
            );
        } catch (e) {
            console.error('Erro ao salvar conversa no Firestore:', e.message);
        }
    }
}

async function limparMemoriaContato(chatId) {
    delete memoriasSalvas[chatId];
    persistirMemoriasLocal();

    const db = getDb();
    if (db) {
        try {
            await db.collection('conversas').doc(docIdSeguro(chatId)).delete();
        } catch (e) {
            console.error('Erro ao apagar conversa no Firestore:', e.message);
        }
    }
}

async function registrarNaMemoria(chatId, autor, texto) {
    const mem = await carregarMemoriaContato(chatId);
    if (!Array.isArray(mem.mensagens)) {
        mem.mensagens = [];
    }
    if (!Array.isArray(mem.temasVistos)) {
        mem.temasVistos = [];
    }

    mem.atualizadoEm = new Date().toLocaleString('pt-BR');
    mem.mensagens.push({
        autor,
        texto,
        hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    });
    if (mem.mensagens.length > 12) {
        mem.mensagens = mem.mensagens.slice(-12);
    }
    await salvarMemoriaContato(chatId);
}

async function gerarBreveLeitura(chatId) {
    const mem = await carregarMemoriaContato(chatId);
    if (!mem.mensagens.length) {
        return 'Ainda nao temos conversas anteriores registradas por aqui.';
    }

    const falasCliente = mem.mensagens
        .filter((m) => m.autor === 'cliente')
        .slice(-3)
        .map((m) => `"${m.texto}"`);

    const partes = [];
    if (mem.nomeIdentificado) {
        partes.push(`Contato: ${mem.nomeIdentificado}`);
    }
    if (mem.temasVistos.length) {
        partes.push(`Assuntos tratados: ${mem.temasVistos.join(', ')}`);
    }
    if (mem.fluxoAtual && mem.fluxoAtual !== 'MENU') {
        partes.push(`Etapa em aberto: ${mem.fluxoAtual}`);
    }
    if (falasCliente.length) {
        partes.push(`Ultimas falas: ${falasCliente.join(' | ')}`);
    }

    return `Leitura breve da conversa:\n- ${partes.join('\n- ')}`;
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

function distanciaLevenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const custo = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + custo
            );
        }
    }
    return dp[m][n];
}

function normalizarTexto(texto) {
    let limpo = texto
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

    limpo = limpo.replace(/([a-z])\1{2,}/g, '$1$1');

    const mapaEmojis = {
        '👴': ' idoso ',
        '👵': ' idosa ',
        '🧓': ' idoso ',
        '💰': ' valor ',
        '💵': ' valor ',
        '💲': ' valor ',
        '🕒': ' horario ',
        '⏰': ' horario ',
        '📅': ' horario ',
        '🩺': ' particular ',
        '🧠': ' particular ',
        '📄': ' documento ',
        '📋': ' menu '
    };

    for (const [emoji, palavra] of Object.entries(mapaEmojis)) {
        limpo = limpo.split(emoji).join(palavra);
    }

    const substituicoes = [
        [/\bvc\b|\bvcs\b|\bvoce\b/g, 'voce'],
        [/\btb\b|\btbm\b|\btamb\b/g, 'tambem'],
        [/\bpq\b|\bporq\b|\bprq\b/g, 'porque'],
        [/\bqnt\b|\bqnts\b|\bquant\b|\bqto\b/g, 'quanto'],
        [/\bvlr\b|\bvlrs\b|\bval\b|\bpreco\b|\bprecos\b|\bcusta\b|\bpagar\b|\bpix\b/g, 'valor'],
        [/\bhr\b|\bhrs\b|\bhora\b|\bhoras\b|\bhorar\b|\bagenda\b|\bagendar\b|\bmarcar\b/g, 'horario'],
        [/\bid\b|\bidos\b|\bidoso\b|\bidosa\b|\bidosos\b|\bvelho\b|\bvelha\b|\b60\+\b|\bscfv\b/g, 'scfv'],
        [/\bcras\b|\bencam\b|\bencaminh\b|\bencaminhamento\b|\bdoc\b|\bdocs\b|\bdocumento\b/g, 'cras'],
        [/\bpart\b|\bpartic\b|\bparticular\b|\braf\b|\bpsi\b|\bpsico\b|\bpsicolog\b|\bpsicologa\b|\bpsicologo\b|\baval\b|\bavaliacao\b/g, 'particular'],
        [/\bmenu\b|\bopc\b|\bopcoes\b|\bopca\b|\binicio\b|\bcomecar\b|\bajuda\b|\bvoltar\b/g, 'menu'],
        [/\boi\b|\bola\b|\boie\b|\boii\b|\bbom dia\b|\bboa tarde\b|\bboa noite\b/g, 'saudacao'],
        [/\bresum\b|\bresumo\b|\bhistorico\b|\bja falei\b|\bja conversamos\b|\bonde paramos\b|\bcontinuar\b|\bcontinua\b/g, 'resumo']
    ];

    for (const [regex, substituto] of substituicoes) {
        limpo = limpo.replace(regex, substituto);
    }

    limpo = limpo
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return limpo;
}

function analisarIntencaoLocal(textoNormalizado) {
    if (!textoNormalizado) return { intencao: null, confianca: 0 };

    if (/\b(limpar memoria|zerar memoria|apagar memoria|zerar)\b/.test(textoNormalizado)) {
        return { intencao: 'LIMPAR_MEMORIA', confianca: 1 };
    }
    if (/\bresumo\b/.test(textoNormalizado)) {
        return { intencao: 'RESUMO', confianca: 1 };
    }

    if (textoNormalizado === '1') return { intencao: 'CRAS', confianca: 1 };
    if (textoNormalizado === '2') return { intencao: 'SCFV', confianca: 1 };
    if (textoNormalizado === '3') return { intencao: 'PARTICULAR', confianca: 1 };
    if (textoNormalizado === '4') return { intencao: 'VALORES', confianca: 1 };
    if (textoNormalizado === '5') return { intencao: 'HORARIOS', confianca: 1 };
    if (textoNormalizado === '0' || textoNormalizado === 'menu') return { intencao: 'MENU', confianca: 1 };

    const scores = {
        CRAS: 0,
        SCFV: 0,
        PARTICULAR: 0,
        VALORES: 0,
        HORARIOS: 0,
        MENU: 0
    };

    const alvos = {
        CRAS: ['cras', 'encaminhamento', 'documento', 'filho', 'filhos', 'familia'],
        SCFV: ['scfv', 'idoso', 'idosa', 'idosos', 'convivencia', 'responsavel', '60'],
        PARTICULAR: ['particular', 'raf', 'avaliacao', 'psicologo', 'psicologa', 'terapia'],
        VALORES: ['valor', 'valores', 'custa', 'preco', 'pagar', '70', 'reais'],
        HORARIOS: ['horario', 'horarios', 'agenda', 'agendar', 'marcar', 'dia', 'manha', 'tarde'],
        MENU: ['menu', 'saudacao', 'ajuda', 'inicio']
    };

    const tokens = textoNormalizado.split(' ').filter(Boolean);

    for (const token of tokens) {
        for (const [intencao, palavras] of Object.entries(alvos)) {
            if (palavras.includes(token)) {
                scores[intencao] += 3;
                continue;
            }
            for (const alvo of palavras) {
                if (alvo.length >= 4 && token.length >= 3) {
                    const dist = distanciaLevenshtein(token, alvo);
                    const tolerancia = alvo.length >= 7 ? 2 : 1;
                    if (dist <= tolerancia || alvo.startsWith(token) || token.startsWith(alvo)) {
                        scores[intencao] += 2;
                        break;
                    }
                }
            }
        }
    }

    let melhorIntencao = null;
    let maiorScore = 0;

    for (const [intencao, pts] of Object.entries(scores)) {
        if (pts > maiorScore) {
            maiorScore = pts;
            melhorIntencao = intencao;
        }
    }

    return {
        intencao: maiorScore >= 2 ? melhorIntencao : null,
        confianca: maiorScore
    };
}

function extrairDadosTriagem(textoOriginal, textoNormalizado, chatId) {
    const fallbackNome = `Cliente WhatsApp (${chatId.split('@')[0].slice(-6)})`;

    const padraoNome = textoOriginal.match(/^(?:nome[:\s-]*)?([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){1,3})(?=,|-|\s+(?:tenho|filhos?|idade|anos|doc|documento|responsavel)\b|$)/i);
    const nome = padraoNome ? padraoNome[1].trim() : fallbackNome;

    const numeros = (textoNormalizado.match(/\b\d+\b/g) || []).map(Number);

    const temDocumento = /\b(tenho|ja|sim|possuo)\b/.test(textoNormalizado) && /\b(doc|documento|encaminhamento)\b/.test(textoNormalizado)
        ? 'Sim'
        : /\b(nao|ainda nao|falta)\b/.test(textoNormalizado) && /\b(doc|documento|encaminhamento)\b/.test(textoNormalizado)
            ? 'Nao / Pendente'
            : 'Nao informado';

    return {
        nome,
        numerosDetectados: numeros,
        temDocumento
    };
}

const MENSAGENS = {
    MENU:
        "Instituto Forja - Atendimento Oficial\n\n" +
        "Digite o numero ou palavra-chave:\n" +
        "1 - CRAS (encaminhamento)\n" +
        "2 - SCFV Idosos (60+)\n" +
        "3 - Particular / RAF (avaliacao)\n" +
        "4 - Valores\n" +
        "5 - Horarios\n\n" +
        "Dica: envie 'resumo' para ver o que ja conversamos ou 'menu' para opcoes.",

    CRAS:
        "Atendimento - CRAS\n\n" +
        "Responda em uma mensagem:\n" +
        "- Nome completo\n" +
        "- Quantos filhos moram com voce e idades\n" +
        "- Se ja tem documento de encaminhamento",

    SCFV:
        "Atendimento - SCFV Idosos (60+)\n\n" +
        "Responda em uma mensagem:\n" +
        "- Nome e idade da pessoa idosa\n" +
        "- Nome e telefone do responsavel",

    PARTICULAR:
        "Atendimento - Particular (RAF)\n\n" +
        "Responda em uma mensagem:\n" +
        "- Nome e idade de quem sera atendido\n" +
        "- Se e para voce ou outra pessoa",

    VALORES:
        "Valores - Instituto Forja (RAF)\n\n" +
        "Avaliacao inicial: R$ 70,00.\n" +
        "Serve para entender sua demanda e definir o plano de cuidado.\n\n" +
        "Digite 3 para iniciar triagem Particular, 5 para horarios ou 'menu'.",

    HORARIOS:
        "Horarios da Avaliacao Inicial (R$ 70,00):\n\n" +
        "- Seg: 14h, 15h, 16h\n" +
        "- Ter: 9h, 10h, 14h\n" +
        "- Qua: 14h, 15h, 17h\n" +
        "- Qui: 9h, 10h, 15h\n" +
        "- Sex: 9h, 14h\n\n" +
        "Digite 3 para iniciar triagem Particular ou 'menu' para voltar."
};

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

const PORT = process.env.PORT || 3000;
http.createServer(async (req, res) => {
    const rota = (req.url || '/').split('?')[0];

    if (rota === '/api/status' || rota === '/status') {
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
});

async function iniciarBot() {
    console.log(
        isFirestoreAtivo()
            ? 'Firestore conectado (projeto clinica-forja)!'
            : 'Aviso: Firestore inativo (verifique .env). Usando backup local.'
    );

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Instituto Forja', 'Chrome', '1.0.0'],
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

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
            await atualizarStatusBot('online', null);
            console.log('Secretaria virtual do Instituto Forja ONLINE e pronta para responder!');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const deveReconectar = statusCode !== DisconnectReason.loggedOut;
            statusAtualBot = deveReconectar ? 'reconectando' : 'desconectado';
            ultimoQrAtual = null;
            await atualizarStatusBot(statusAtualBot, null);
            console.log('Conexao encerrada. Codigo:', statusCode, '| Reconectando:', deveReconectar);
            if (deveReconectar) {
                setTimeout(iniciarBot, 2000);
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

            const textoNormalizado = normalizarTexto(textoOriginal);
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

            const enviar = async (text) => {
                await registrarNaMemoria(chatId, 'secretaria', text);
                await sock.sendMessage(chatId, { text });
                console.log(`[ENVIADO] Para: ${chatId}`);
            };

            const analise = analisarIntencaoLocal(textoNormalizado);

            if (analise.intencao === 'LIMPAR_MEMORIA') {
                await limparMemoriaContato(chatId);
                sessao.etapa = 'MENU';
                sessao.dados = {};
                await enviar("Memoria desta conversa apagada. Vamos recomecar do zero!\n\n" + MENSAGENS.MENU);
                continue;
            }

            if (analise.intencao === 'RESUMO') {
                await enviar(await gerarBreveLeitura(chatId));
                continue;
            }

            const ehSaudacaoSimples = /\bsaudacao\b/.test(textoNormalizado) && textoNormalizado.split(' ').length <= 3;
            if (ehSaudacaoSimples && mem.mensagens.length > 2) {
                const leitura = await gerarBreveLeitura(chatId);
                await enviar(
                    `${leitura}\n\nSeguimos por aqui! Se quiser mudar de assunto, digite 1 a 5 ou 'menu'.`
                );
                continue;
            }

            if (analise.intencao === 'MENU') {
                sessao.etapa = 'MENU';
                sessao.dados = {};
                mem.fluxoAtual = 'MENU';
                await salvarMemoriaContato(chatId);
                await enviar(MENSAGENS.MENU);
                continue;
            }

            const emTriagem = ['CRAS_ANDAMENTO', 'SCFV_ANDAMENTO', 'PARTICULAR_ANDAMENTO'].includes(sessao.etapa);

            if (emTriagem) {
                if (analise.intencao === 'VALORES') {
                    if (!mem.temasVistos.includes('Valores')) mem.temasVistos.push('Valores');
                    await salvarMemoriaContato(chatId);
                    await enviar(MENSAGENS.VALORES);
                    continue;
                }
                if (analise.intencao === 'HORARIOS') {
                    if (!mem.temasVistos.includes('Horarios')) mem.temasVistos.push('Horarios');
                    await salvarMemoriaContato(chatId);
                    await enviar(MENSAGENS.HORARIOS);
                    continue;
                }

                const extraidos = extrairDadosTriagem(textoOriginal, textoNormalizado, chatId);
                if (extraidos.nome && !extraidos.nome.startsWith('Cliente WhatsApp')) {
                    mem.nomeIdentificado = extraidos.nome;
                }

                await salvarRegistro({
                    tipo: sessao.dados.tipo,
                    nome: extraidos.nome,
                    telefone: chatId.split('@')[0],
                    numerosDetectados: extraidos.numerosDetectados,
                    temDocumento: extraidos.temDocumento,
                    detalhes: textoOriginal,
                    textoNormalizado,
                    origem: 'whatsapp'
                });

                await enviar(
                    `Dados registrados com sucesso para ${extraidos.nome}. Nossa equipe do Instituto Forja vai analisar e continuar o atendimento por aqui. Digite 'resumo' para rever ou 'menu' para outras opcoes.`
                );

                sessao.etapa = 'MENU';
                sessao.dados = {};
                mem.fluxoAtual = 'MENU';
                await salvarMemoriaContato(chatId);
                continue;
            }

            if (analise.intencao === 'CRAS') {
                sessao.etapa = 'CRAS_ANDAMENTO';
                sessao.dados = { tipo: 'CRAS' };
                mem.fluxoAtual = 'CRAS_ANDAMENTO';
                if (!mem.temasVistos.includes('CRAS')) mem.temasVistos.push('CRAS');
                await salvarMemoriaContato(chatId);
                await enviar(MENSAGENS.CRAS);
            } else if (analise.intencao === 'SCFV') {
                sessao.etapa = 'SCFV_ANDAMENTO';
                sessao.dados = { tipo: 'SCFV Idosos' };
                mem.fluxoAtual = 'SCFV_ANDAMENTO';
                if (!mem.temasVistos.includes('SCFV Idosos')) mem.temasVistos.push('SCFV Idosos');
                await salvarMemoriaContato(chatId);
                await enviar(MENSAGENS.SCFV);
            } else if (analise.intencao === 'PARTICULAR') {
                sessao.etapa = 'PARTICULAR_ANDAMENTO';
                sessao.dados = { tipo: 'Particular' };
                mem.fluxoAtual = 'PARTICULAR_ANDAMENTO';
                if (!mem.temasVistos.includes('Particular')) mem.temasVistos.push('Particular');
                await salvarMemoriaContato(chatId);
                await enviar(MENSAGENS.PARTICULAR);
            } else if (analise.intencao === 'VALORES') {
                if (!mem.temasVistos.includes('Valores')) mem.temasVistos.push('Valores');
                await salvarMemoriaContato(chatId);
                await enviar(MENSAGENS.VALORES);
            } else if (analise.intencao === 'HORARIOS') {
                if (!mem.temasVistos.includes('Horarios')) mem.temasVistos.push('Horarios');
                await salvarMemoriaContato(chatId);
                await enviar(MENSAGENS.HORARIOS);
            } else {
                await enviar(MENSAGENS.MENU);
            }
        }
    });
}

iniciarBot();