const crypto = require('crypto');
const fs = require('fs');

const ADMIN_USER = (process.env.ADMIN_USER || 'forja@adm.com.br').trim().toLowerCase();
const ADMIN_PASS = (process.env.ADMIN_PASS || 'forjaadm').trim();
const SEGREDO_SESSAO = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

let resetInicialExecutado = false;

function criarTokenSessaoAdmin(usuario) {
    const expiraEm = Date.now() + 24 * 60 * 60 * 1000;
    const payload = Buffer.from(JSON.stringify({ usuario, expiraEm })).toString('base64url');
    const assinatura = crypto
        .createHmac('sha256', SEGREDO_SESSAO)
        .update(payload)
        .digest('base64url');
    return `${payload}.${assinatura}`;
}

function verificarTokenAdmin(req) {
    const authHeader = req.headers['authorization'] || '';
    const partes = authHeader.split(' ');
    if (partes.length !== 2 || partes[0] !== 'Bearer' || !partes[1]) {
        return { ok: false, status: 401, erro: 'Sessao nao autenticada' };
    }

    const token = partes[1];
    const partesToken = token.split('.');
    if (partesToken.length !== 2) {
        return { ok: false, status: 401, erro: 'Token invalido' };
    }

    const [payload, assinatura] = partesToken;
    const esperada = crypto
        .createHmac('sha256', SEGREDO_SESSAO)
        .update(payload)
        .digest('base64url');

    if (assinatura !== esperada) {
        return { ok: false, status: 401, erro: 'Assinatura invalida' };
    }

    try {
        const dados = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!dados.expiraEm || Date.now() > dados.expiraEm) {
            return { ok: false, status: 401, erro: 'Sessao expirada' };
        }
        return { ok: true, usuario: dados.usuario };
    } catch (_) {
        return { ok: false, status: 401, erro: 'Token corrompido' };
    }
}

function lerAgendamentosLocais(dbFile) {
    try {
        if (!fs.existsSync(dbFile)) return [];
        const raw = fs.readFileSync(dbFile, 'utf8');
        if (!raw.trim()) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function extrairTimestamp(valor) {
    if (!valor) return 0;
    if (typeof valor === 'number') return valor > 0 ? valor : 0;
    if (typeof valor === 'string') {
        if (/^\d{10,}$/.test(valor.trim())) return Number(valor.trim());
        const d = new Date(valor).getTime();
        return Number.isNaN(d) ? 0 : d;
    }
    if (typeof valor?.toMillis === 'function') return valor.toMillis();
    if (typeof valor?.seconds === 'number') return valor.seconds * 1000;
    return 0;
}

function obterCortePeriodoMs(periodo, agora) {
    if (periodo === 'hoje') {
        const inicioHoje = new Date(agora);
        inicioHoje.setHours(0, 0, 0, 0);
        return inicioHoje.getTime();
    }
    if (periodo === '7d') return agora - 7 * 86400000;
    if (periodo === '30d') return agora - 30 * 86400000;
    return 0;
}

async function limparColecaoFirestore(db, nomeColecao) {
    const snap = await db.collection(nomeColecao).get();
    if (snap.empty) return 0;

    let removidos = 0;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 400) {
        const lote = db.batch();
        const fatia = docs.slice(i, i + 400);
        fatia.forEach((doc) => lote.delete(doc.ref));
        await lote.commit();
        removidos += fatia.length;
    }
    return removidos;
}

async function resetarDadosOficiais({ dbFile, getDb, onReset }) {
    fs.writeFileSync(dbFile, JSON.stringify([], null, 2), 'utf8');
    if (typeof onReset === 'function') {
        onReset();
    }

    const db = getDb();
    let removidosFirestore = { agendamentos: 0, conversas: 0, supervisao_chefe: 0 };

    if (db) {
        removidosFirestore = {
            agendamentos: await limparColecaoFirestore(db, 'agendamentos'),
            conversas: await limparColecaoFirestore(db, 'conversas'),
            supervisao_chefe: await limparColecaoFirestore(db, 'supervisao_chefe')
        };
    }

    return {
        resetadoEm: new Date().toLocaleString('pt-BR'),
        removidosFirestore
    };
}

async function executarResetInicialSeSolicitado(contexto) {
    if (resetInicialExecutado) return;
    if (String(process.env.RESET_ON_BOOT || '').trim().toLowerCase() !== 'true') return;
    resetInicialExecutado = true;

    try {
        const res = await resetarDadosOficiais(contexto);
        console.log('[RESET_ON_BOOT] Dados oficiais zerados:', JSON.stringify(res.removidosFirestore));
    } catch (e) {
        console.error('[ERRO RESET_ON_BOOT]', e.message);
    }
}

async function montarPainelAdmin(contexto, periodoRaw = '7d') {
    const { dbFile, getDb, estaConectado, statusAtualBot } = contexto;
    const periodo = ['hoje', '7d', '30d', 'tudo'].includes(periodoRaw) ? periodoRaw : '7d';
    const db = getDb();
    let agendamentos = [];
    let conversas = [];
    let supervisao = [];
    let statusDoc = null;
    let firestoreLeuAgendamentos = false;

    if (db) {
        try {
            const [snapAgend, snapConv, snapSup, docStatus] = await Promise.all([
                db.collection('agendamentos').get(),
                db.collection('conversas').get(),
                db.collection('supervisao_chefe').get(),
                db.collection('bot_status').doc('whatsapp').get()
            ]);

            firestoreLeuAgendamentos = true;
            agendamentos = snapAgend.docs.map((d) => ({ id: d.id, ...d.data() }));
            conversas = snapConv.docs.map((d) => ({ id: d.id, ...d.data() }));
            supervisao = snapSup.docs.map((d) => ({ id: d.id, ...d.data() }));
            if (docStatus.exists) statusDoc = docStatus.data();
        } catch (e) {
            console.error('[ERRO montarPainelAdmin Firestore]', e.message);
        }
    }

    if (!firestoreLeuAgendamentos && !agendamentos.length) {
        agendamentos = lerAgendamentosLocais(dbFile);
    }

    const agora = Date.now();
    const corteMs = obterCortePeriodoMs(periodo, agora);

    const agendamentosFiltrados = agendamentos
        .map((a) => ({
            ...a,
            ts: extrairTimestamp(a.criadoEm) || extrairTimestamp(a.id)
        }))
        .filter((a) => corteMs === 0 || (a.ts > 0 && a.ts >= corteMs))
        .sort((a, b) => b.ts - a.ts);

    const supervisaoFiltrada = supervisao
        .map((s) => ({
            ...s,
            ts: extrairTimestamp(s.atualizadoEm) || extrairTimestamp(s.id)
        }))
        .filter((s) => corteMs === 0 || (s.ts > 0 && s.ts >= corteMs))
        .sort((a, b) => b.ts - a.ts);

    let totalEntradas = 0;
    const msgsPorDiaMap = new Map();

    conversas.forEach((c) => {
        const msgs = Array.isArray(c.msgs) ? c.msgs : [];
        msgs.forEach((m) => {
            if (m.origem && m.origem !== 'cliente') return;
            const ts = extrairTimestamp(m.em);
            if (corteMs > 0 && (!ts || ts < corteMs)) return;
            totalEntradas += 1;

            if (ts > 0) {
                const chave = new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
                msgsPorDiaMap.set(chave, (msgsPorDiaMap.get(chave) || 0) + 1);
            }
        });
    });

    const agendsPorDiaMap = new Map();
    agendamentosFiltrados.forEach((a) => {
        if (!a.ts) return;
        const chave = new Date(a.ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        agendsPorDiaMap.set(chave, (agendsPorDiaMap.get(chave) || 0) + 1);
    });

    const limiteAtualMs = 24 * 60 * 60 * 1000;
    const contatosMap = new Map();

    conversas.forEach((c) => {
        const cid = c.chatId || c.id;
        if (!cid) return;
        const tsAtualizado = extrairTimestamp(c.atualizadoEm);
        if (corteMs > 0 && (!tsAtualizado || tsAtualizado < corteMs)) return;
        contatosMap.set(cid, {
            chatId: cid,
            msgs: Array.isArray(c.msgs) ? c.msgs : [],
            fluxoAtual: c.fluxoAtual || 'MENU',
            atualizadoMs: tsAtualizado
        });
    });

    agendamentosFiltrados.forEach((a) => {
        if (!a.chatId) return;
        if (!contatosMap.has(a.chatId)) {
            contatosMap.set(a.chatId, {
                chatId: a.chatId,
                msgs: [],
                fluxoAtual: 'MENU',
                atualizadoMs: a.ts || 0
            });
        }
    });

    const historicoAgendContato = new Map();
    agendamentosFiltrados.forEach((a) => {
        if (!a.chatId) return;
        historicoAgendContato.set(a.chatId, (historicoAgendContato.get(a.chatId) || 0) + 1);
    });

    let novos = 0;
    let atuais = 0;
    let antigos = 0;

    contatosMap.forEach((c, cid) => {
        const qtdMsgs = c.msgs.length;
        const qtdAgend = historicoAgendContato.get(cid) || 0;
        const recente = c.atualizadoMs > 0 && (agora - c.atualizadoMs) <= limiteAtualMs;

        if (qtdAgend > 1 || (!recente && qtdMsgs > 4)) {
            antigos += 1;
        } else if (recente || (c.fluxoAtual && c.fluxoAtual !== 'MENU')) {
            atuais += 1;
        } else {
            novos += 1;
        }
    });

    const totalClientes = novos + atuais + antigos;
    const pctNovos = totalClientes > 0 ? Math.round((novos / totalClientes) * 100) : 0;
    const pctAtuais = totalClientes > 0 ? Math.round((atuais / totalClientes) * 100) : 0;
    const pctAntigos = totalClientes > 0 ? Math.max(0, 100 - pctNovos - pctAtuais) : 0;

    const qtdDiasSerie = periodo === '30d' ? 14 : 7;
    const serie = [];
    for (let i = qtdDiasSerie - 1; i >= 0; i--) {
        const d = new Date(agora - i * 86400000);
        const chave = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        serie.push({
            chave,
            entradas: msgsPorDiaMap.get(chave) || 0,
            agendamentos: agendsPorDiaMap.get(chave) || 0
        });
    }

    return {
        periodo,
        whatsapp: {
            conectado: estaConectado(),
            status: statusAtualBot,
            atualizadoEmTexto: statusDoc?.atualizadoEmTexto || new Date().toLocaleString('pt-BR')
        },
        resumo: {
            totalEntradas,
            totalAgendamentos: agendamentosFiltrados.length,
            totalConversas: totalClientes,
            totalSupervisao: supervisaoFiltrada.length
        },
        percentuais: {
            totalClientes,
            novos: { qtd: novos, pct: pctNovos },
            atuais: { qtd: atuais, pct: pctAtuais },
            antigos: { qtd: antigos, pct: pctAntigos }
        },
        seriePeriodo: serie,
        agendamentosRecentes: agendamentosFiltrados.slice(0, 15).map((a) => ({
            id: a.id,
            nome: a.nome || 'Sem nome',
            tipo: a.tipo || 'Triagem',
            contato: a.contato || (a.chatId ? a.chatId.split('@')[0] : '-'),
            dataRegistro: a.dataRegistro || '-'
        })),
        entradasRecentes: supervisaoFiltrada.slice(0, 12).map((s) => ({
            chatId: s.chatId,
            contato: s.contato || (s.chatId ? s.chatId.split('@')[0] : '-'),
            nomeCliente: s.nomeCliente || 'Não identificado',
            fluxoAtual: s.fluxoAtual || 'MENU',
            prioridade: s.prioridade || 'NORMAL',
            ultimaEntradaCliente: s.ultimaEntradaCliente || '',
            acaoSugerida: s.acaoSugerida || '',
            atualizadoEmTexto: s.atualizadoEmTexto || ''
        }))
    };
}

function renderizarPaginaQrHtml(qrDataUrl, conectado) {
    const rotuloStatus = conectado ? 'Conectado' : 'Desconectado';

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WhatsApp QR Code & Painel ADM</title>
  <style>
    * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    body { margin: 0; min-height: 100vh; background: #090d16; color: #f8fafc; padding: 20px; }
    .container-qr { min-height: calc(100vh - 40px); display: flex; align-items: center; justify-content: center; }
    .box {
      width: 100%; max-width: 360px; background: #111827; border: 1px solid #1f2937;
      border-radius: 18px; padding: 28px 24px; text-align: center; display: flex;
      flex-direction: column; align-items: center; gap: 16px; box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5);
    }
    .status {
      display: inline-flex; align-items: center; gap: 8px; padding: 7px 14px;
      border-radius: 999px; font-size: 13px; font-weight: 600;
      background: ${conectado ? 'rgba(16, 185, 129, 0.14)' : 'rgba(239, 68, 68, 0.14)'};
      color: ${conectado ? '#34d399' : '#f87171'};
      border: 1px solid ${conectado ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)'};
    }
    .status.online { background: rgba(16, 185, 129, 0.14); color: #34d399; border-color: rgba(16, 185, 129, 0.35); }
    .status.offline { background: rgba(239, 68, 68, 0.14); color: #f87171; border-color: rgba(239, 68, 68, 0.35); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .qr-wrap { background: #ffffff; padding: 14px; border-radius: 14px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); }
    .qr-wrap img { display: block; width: 220px; height: 220px; }
    .btn {
      width: 100%; padding: 11px 18px; border: none; border-radius: 10px;
      background: #2563eb; color: #ffffff; font-size: 14px; font-weight: 600; cursor: pointer;
    }
    .btn:hover { background: #1d4ed8; }
    .btn-adm {
      width: 100%; padding: 11px 18px; border: 1px solid #334155; border-radius: 10px;
      background: #1e293b; color: #e2e8f0; font-size: 14px; font-weight: 600; cursor: pointer;
    }
    .btn-adm:hover { background: #334155; }
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(2, 6, 23, 0.82); display: none;
      align-items: center; justify-content: center; padding: 16px; z-index: 50; overflow-y: auto;
    }
    .modal-backdrop.aberto { display: flex; }
    .login-card {
      width: 100%; max-width: 380px; background: #111827; border: 1px solid #1f2937;
      border-radius: 16px; padding: 24px; display: flex; flex-direction: column; gap: 14px;
    }
    .login-card h2, .adm-header h2 { margin: 0; font-size: 18px; }
    .campo { display: flex; flex-direction: column; gap: 6px; text-align: left; font-size: 13px; color: #cbd5e1; }
    .campo input {
      width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #334155;
      background: #090d16; color: #f8fafc; font-size: 14px;
    }
    .erro-msg { color: #f87171; font-size: 13px; min-height: 18px; text-align: left; }
    .adm-painel {
      width: 100%; max-width: 1060px; max-height: 92vh; overflow-y: auto;
      background: #0f172a; border: 1px solid #1e293b; border-radius: 18px; padding: 22px;
      display: flex; flex-direction: column; gap: 18px;
    }
    .adm-header {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: 12px; border-bottom: 1px solid #1e293b; padding-bottom: 14px;
    }
    .adm-acoes { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .barra-filtros {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: 10px; background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 10px 14px;
    }
    .grupo-periodo { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .btn-periodo {
      padding: 6px 12px; border-radius: 8px; border: 1px solid #334155;
      background: #0f172a; color: #cbd5e1; font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .btn-periodo.ativo { background: #2563eb; border-color: #2563eb; color: #ffffff; }
    .btn-sm {
      padding: 8px 14px; border-radius: 8px; border: 1px solid #334155;
      background: #1e293b; color: #f8fafc; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .btn-sm.primario { background: #2563eb; border-color: #2563eb; }
    .btn-sm.perigo { background: rgba(239, 68, 68, 0.14); border-color: rgba(239, 68, 68, 0.4); color: #fca5a5; }
    .grid-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 14px; }
    .card .rotulo { font-size: 12px; color: #94a3b8; }
    .card .valor { font-size: 24px; font-weight: 700; margin-top: 6px; }
    .card .sub { font-size: 12px; color: #64748b; margin-top: 4px; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
    .barra-item { margin-bottom: 10px; }
    .barra-topo { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px; }
    .barra-fundo { height: 8px; background: #1e293b; border-radius: 999px; overflow: hidden; }
    .barra-fill { height: 100%; border-radius: 999px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 10px; border-bottom: 1px solid #1e293b; text-align: left; vertical-align: top; }
    th { color: #94a3b8; font-weight: 600; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #1e293b; color: #93c5fd; }
    .badge.alta { background: rgba(239, 68, 68, 0.2); color: #fca5a5; }
    .badge.media { background: rgba(245, 158, 11, 0.2); color: #fcd34d; }
  </style>
</head>
<body>
  <div class="container-qr">
    <div class="box">
      <div id="statusBadge" class="status ${conectado ? 'online' : 'offline'}">
        <span class="dot"></span>
        <span id="statusTexto">${rotuloStatus}</span>
      </div>
      <div id="qrArea">${qrDataUrl ? `<div class="qr-wrap"><img id="qrImg" src="${qrDataUrl}" alt="QR Code" /></div>` : ''}</div>
      <button id="btnAtualizar" class="btn" type="button">Atualizar</button>
      <button id="btnAbrirAdm" class="btn-adm" type="button">Painel ADM</button>
    </div>
  </div>

  <div id="modalLogin" class="modal-backdrop">
    <form id="formLogin" class="login-card">
      <h2>Acesso Painel ADM</h2>
      <label class="campo">
        E-mail
        <input id="admUsuario" type="email" required autocomplete="username" placeholder="forja@adm.com.br" />
      </label>
      <label class="campo">
        Senha
        <input id="admSenha" type="password" required autocomplete="current-password" placeholder="••••••••" />
      </label>
      <div id="erroLogin" class="erro-msg"></div>
      <button type="submit" class="btn">Entrar</button>
      <button type="button" id="btnFecharLogin" class="btn-adm">Cancelar</button>
    </form>
  </div>

  <div id="modalAdm" class="modal-backdrop">
    <div class="adm-painel">
      <div class="adm-header">
        <div>
          <h2>Painel ADM — Secretaria Instituto Forja</h2>
          <div id="admSubtitulo" style="font-size: 12px; color: #94a3b8; margin-top: 4px;">Carregando...</div>
        </div>
        <div class="adm-acoes">
          <button id="btnResetarDados" class="btn-sm perigo" type="button">Resetar dados oficiais</button>
          <button id="btnAtualizarAdm" class="btn-sm primario" type="button">Atualizar dados</button>
          <button id="btnSairAdm" class="btn-sm" type="button">Sair</button>
        </div>
      </div>

      <div class="barra-filtros">
        <div class="grupo-periodo">
          <span style="font-size: 12px; color: #94a3b8; margin-right: 4px;">Período:</span>
          <button class="btn-periodo" data-periodo="hoje" type="button">Hoje</button>
          <button class="btn-periodo ativo" data-periodo="7d" type="button">7 dias</button>
          <button class="btn-periodo" data-periodo="30d" type="button">30 dias</button>
          <button class="btn-periodo" data-periodo="tudo" type="button">Tudo</button>
        </div>
        <div id="infoPeriodo" style="font-size: 12px; color: #94a3b8;">Dados oficiais • 7 dias</div>
      </div>

      <div id="cardsResumo" class="grid-cards"></div>

      <div class="grid-2">
        <div class="card">
          <div style="font-weight: 600; margin-bottom: 12px;">Percentual de Clientes (Oficiais)</div>
          <div id="percentuaisClientes"></div>
        </div>
        <div class="card">
          <div style="font-weight: 600; margin-bottom: 10px;">Entradas e Agendamentos</div>
          <div id="graficoArea"></div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div style="font-weight: 600; margin-bottom: 10px;">Agendamentos / Triagens</div>
          <div style="overflow-x: auto;">
            <table>
              <thead>
                <tr><th>Nome</th><th>Tipo</th><th>Contato</th><th>Data</th></tr>
              </thead>
              <tbody id="tabelaAgendamentos"></tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div style="font-weight: 600; margin-bottom: 10px;">Entradas e Supervisão</div>
          <div style="overflow-x: auto;">
            <table>
              <thead>
                <tr><th>Contato</th><th>Fluxo / Prioridade</th><th>Última mensagem</th></tr>
              </thead>
              <tbody id="tabelaEntradas"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let ultimoQrRenderizado = ${JSON.stringify(qrDataUrl || '')};
    let ultimoConectadoRenderizado = ${JSON.stringify(conectado)};
    let tokenAdm = sessionStorage.getItem('forja_adm_token') || '';
    let periodoAtual = '7d';

    const rotulosPeriodo = { hoje: 'Hoje', '7d': '7 dias', '30d': '30 dias', tudo: 'Todo o histórico oficial' };

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
          qrArea.innerHTML = qrAgora ? '<div class="qr-wrap"><img id="qrImg" src="' + qrAgora + '" alt="QR Code" /></div>' : '';
        }
      } catch (_) {}
    }

    function abrirModal(id) { document.getElementById(id).classList.add('aberto'); }
    function fecharModal(id) { document.getElementById(id).classList.remove('aberto'); }

    function atualizarBotoesPeriodo() {
      document.querySelectorAll('.btn-periodo').forEach((btn) => {
        btn.classList.toggle('ativo', btn.dataset.periodo === periodoAtual);
      });
      document.getElementById('infoPeriodo').textContent = 'Dados oficiais • ' + (rotulosPeriodo[periodoAtual] || periodoAtual);
    }

    function renderGrafico(serie) {
      const maxVal = Math.max(1, ...serie.map((d) => Math.max(d.entradas || 0, d.agendamentos || 0)));
      const largura = Math.max(440, serie.length * 56);
      const altura = 150;
      const passoX = largura / Math.max(serie.length, 1);

      const barras = serie.map((d, idx) => {
        const hEnt = Math.round(((d.entradas || 0) / maxVal) * 95);
        const hAg = Math.round(((d.agendamentos || 0) / maxVal) * 95);
        const xBase = Math.round(idx * passoX + 8);
        return (
          '<rect x="' + xBase + '" y="' + (115 - hEnt) + '" width="12" height="' + hEnt + '" rx="3" fill="#3b82f6" />' +
          '<rect x="' + (xBase + 15) + '" y="' + (115 - hAg) + '" width="12" height="' + hAg + '" rx="3" fill="#10b981" />' +
          '<text x="' + (xBase + 13) + '" y="136" text-anchor="middle" fill="#94a3b8" font-size="10">' + d.chave + '</text>'
        );
      }).join('');

      document.getElementById('graficoArea').innerHTML =
        '<div style="font-size:12px;color:#94a3b8;margin-bottom:6px;">' +
        '<span style="color:#3b82f6;">■ Entradas</span> &nbsp; <span style="color:#10b981;">■ Agendamentos</span></div>' +
        '<svg viewBox="0 0 ' + largura + ' ' + altura + '" style="width:100%;height:auto;display:block;">' + barras + '</svg>';
    }

    function renderPainel(dados) {
      atualizarBotoesPeriodo();
      const zapTexto = dados.whatsapp.conectado ? 'Online' : dados.whatsapp.status;
      document.getElementById('admSubtitulo').textContent =
        'WhatsApp: ' + zapTexto + ' • Atualizado: ' + dados.whatsapp.atualizadoEmTexto;

      document.getElementById('cardsResumo').innerHTML = [
        { r: 'Entradas Oficiais', v: dados.resumo.totalEntradas, s: 'Mensagens de clientes' },
        { r: 'Agendamentos / Triagens', v: dados.resumo.totalAgendamentos, s: 'Registros salvos' },
        { r: 'Clientes Mapeados', v: dados.resumo.totalConversas, s: 'Contatos no período' },
        { r: 'Supervisão', v: dados.resumo.totalSupervisao, s: 'Pareceres registrados' }
      ].map((c) =>
        '<div class="card"><div class="rotulo">' + c.r + '</div><div class="valor">' + c.v + '</div><div class="sub">' + c.s + '</div></div>'
      ).join('');

      const p = dados.percentuais;
      document.getElementById('percentuaisClientes').innerHTML = p.totalClientes === 0
        ? '<div style="font-size:13px;color:#94a3b8;">Sem clientes oficiais no período selecionado.</div>'
        : [
            { label: 'Novos', info: p.novos, cor: '#3b82f6' },
            { label: 'Atuais', info: p.atuais, cor: '#10b981' },
            { label: 'Antigos', info: p.antigos, cor: '#f59e0b' }
          ].map((item) =>
            '<div class="barra-item">' +
              '<div class="barra-topo"><span>' + item.label + ' (' + item.info.qtd + ')</span><strong>' + item.info.pct + '%</strong></div>' +
              '<div class="barra-fundo"><div class="barra-fill" style="width:' + item.info.pct + '%;background:' + item.cor + ';"></div></div>' +
            '</div>'
          ).join('');

      renderGrafico(dados.seriePeriodo || []);

      document.getElementById('tabelaAgendamentos').innerHTML = (dados.agendamentosRecentes || []).length
        ? dados.agendamentosRecentes.map((a) =>
            '<tr><td>' + a.nome + '</td><td>' + a.tipo + '</td><td>' + a.contato + '</td><td>' + a.dataRegistro + '</td></tr>'
          ).join('')
        : '<tr><td colspan="4" style="color:#94a3b8;">Nenhum agendamento oficial no período.</td></tr>';

      document.getElementById('tabelaEntradas').innerHTML = (dados.entradasRecentes || []).length
        ? dados.entradasRecentes.map((e) => {
            const cls = e.prioridade === 'ALTA' ? 'alta' : (e.prioridade === 'MEDIA' ? 'media' : '');
            return '<tr>' +
              '<td>' + (e.nomeCliente !== 'Não identificado' ? e.nomeCliente + ' (' + e.contato + ')' : e.contato) + '</td>' +
              '<td><span class="badge">' + e.fluxoAtual + '</span> <span class="badge ' + cls + '">' + e.prioridade + '</span></td>' +
              '<td>' + (e.ultimaEntradaCliente || '-') + '</td>' +
            '</tr>';
          }).join('')
        : '<tr><td colspan="3" style="color:#94a3b8;">Nenhuma entrada oficial no período.</td></tr>';
    }

    async function carregarPainelAdmin() {
      if (!tokenAdm) {
        abrirModal('modalLogin');
        return;
      }

      try {
        const resp = await fetch('/api/admin/resumo?periodo=' + encodeURIComponent(periodoAtual), {
          headers: { Authorization: 'Bearer ' + tokenAdm },
          cache: 'no-store'
        });
        if (resp.status === 401 || resp.status === 403) {
          tokenAdm = '';
          sessionStorage.removeItem('forja_adm_token');
          fecharModal('modalAdm');
          abrirModal('modalLogin');
          return;
        }
        const dados = await resp.json();
        renderPainel(dados);
        abrirModal('modalAdm');
      } catch (_) {
        document.getElementById('admSubtitulo').textContent = 'Erro ao carregar dados do painel.';
      }
    }

    async function resetarDadosOficiais() {
      if (!tokenAdm) {
        abrirModal('modalLogin');
        return;
      }
      const confirmar = window.confirm('Deseja resetar todos os registros de agendamentos, conversas e supervisão para iniciar do zero com dados oficiais?');
      if (!confirmar) return;

      try {
        const resp = await fetch('/api/admin/resetar', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + tokenAdm }
        });
        if (resp.status === 401 || resp.status === 403) {
          tokenAdm = '';
          sessionStorage.removeItem('forja_adm_token');
          fecharModal('modalAdm');
          abrirModal('modalLogin');
          return;
        }
        if (resp.ok) await carregarPainelAdmin();
      } catch (_) {}
    }

    document.querySelectorAll('.btn-periodo').forEach((btn) => {
      btn.addEventListener('click', async () => {
        periodoAtual = btn.dataset.periodo || '7d';
        atualizarBotoesPeriodo();
        await carregarPainelAdmin();
      });
    });

    document.getElementById('btnAtualizar').addEventListener('click', sincronizarEstado);
    document.getElementById('btnAbrirAdm').addEventListener('click', carregarPainelAdmin);
    document.getElementById('btnFecharLogin').addEventListener('click', () => fecharModal('modalLogin'));
    document.getElementById('btnAtualizarAdm').addEventListener('click', carregarPainelAdmin);
    document.getElementById('btnResetarDados').addEventListener('click', resetarDadosOficiais);
    document.getElementById('btnSairAdm').addEventListener('click', () => {
      tokenAdm = '';
      sessionStorage.removeItem('forja_adm_token');
      fecharModal('modalAdm');
    });

    document.getElementById('formLogin').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const erroEl = document.getElementById('erroLogin');
      erroEl.textContent = '';

      const usuario = document.getElementById('admUsuario').value.trim();
      const password = document.getElementById('admSenha').value;

      try {
        const resp = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usuario, password })
        });
        const data = await resp.json();
        if (!resp.ok || !data.token) {
          erroEl.textContent = data.erro || 'E-mail ou senha inválidos.';
          return;
        }
        tokenAdm = data.token;
        sessionStorage.setItem('forja_adm_token', tokenAdm);
        document.getElementById('admSenha').value = '';
        fecharModal('modalLogin');
        await carregarPainelAdmin();
      } catch (_) {
        erroEl.textContent = 'Falha ao conectar com o servidor.';
      }
    });

    setInterval(sincronizarEstado, 2000);
  </script>
</body>
</html>`;
}

async function tratarRotaAdmin(req, res, rota, urlCompleta, contexto) {
    await executarResetInicialSeSolicitado(contexto);

    if (rota === '/api/admin/login' && req.method === 'POST') {
        try {
            const { usuario, email, password } = await contexto.lerCorpoJson(req);
            const loginInformado = String(usuario || email || '').trim().toLowerCase();
            const senhaInformada = String(password || '').trim();

            if (loginInformado === ADMIN_USER && senhaInformada === ADMIN_PASS) {
                const token = criarTokenSessaoAdmin(loginInformado);
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store'
                });
                res.end(JSON.stringify({ token, usuario: loginInformado }));
                return true;
            }

            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ erro: 'E-mail ou senha inválidos.' }));
        } catch (_) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ erro: 'Dados inválidos.' }));
        }
        return true;
    }

    if (rota === '/api/admin/resumo') {
        const auth = verificarTokenAdmin(req);
        if (!auth.ok) {
            res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ erro: auth.erro }));
            return true;
        }

        try {
            const periodo = (urlCompleta.searchParams.get('periodo') || '7d').trim().toLowerCase();
            const dadosPainel = await montarPainelAdmin(contexto, periodo);
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(JSON.stringify(dadosPainel));
        } catch (e) {
            console.error('[ERRO /api/admin/resumo]', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ erro: 'Erro ao montar resumo ADM' }));
        }
        return true;
    }

    if (rota === '/api/admin/resetar' && req.method === 'POST') {
        const auth = verificarTokenAdmin(req);
        if (!auth.ok) {
            res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ erro: auth.erro }));
            return true;
        }

        try {
            const resultado = await resetarDadosOficiais(contexto);
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(JSON.stringify({ ok: true, ...resultado }));
        } catch (e) {
            console.error('[ERRO /api/admin/resetar]', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ erro: 'Erro ao resetar dados oficiais' }));
        }
        return true;
    }

    return false;
}

module.exports = {
    executarResetInicialSeSolicitado,
    renderizarPaginaQrHtml,
    tratarRotaAdmin
};