const fs = require('fs');
const path = require('path');
const { admin, getDb } = require('./firebase');
const { MENSAGENS } = require('./mensagens');

const MEMORIA_FILE = path.join(__dirname, 'memorias_conversas.json');
let memoriasSalvas = {};

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
        console.error('Erro ao ler memorias_conversas.json:', e.message);
    }
} else {
    fs.writeFileSync(MEMORIA_FILE, JSON.stringify({}, null, 2), 'utf8');
}

function persistirMemoriasLocal() {
    try {
        fs.writeFileSync(MEMORIA_FILE, JSON.stringify(memoriasSalvas, null, 2), 'utf8');
    } catch (e) {
        console.error('Erro ao salvar memorias_conversas.json:', e.message);
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

function tentarCapturarNome(textoOriginal) {
    const matchApresentacao = textoOriginal.match(
        /(?:meu nome [eé]|me chamo|sou o|sou a|aqui [eé](?: o| a)?)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){0,2})/i
    );
    if (matchApresentacao) {
        return matchApresentacao[1].trim();
    }

    const matchTriagem = textoOriginal.match(
        /^(?:nome[:\s-]*)?([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){1,3})(?=,|-|\s+(?:tenho|filhos?|idade|anos|doc|documento|responsavel)\b|$)/i
    );
    return matchTriagem ? matchTriagem[1].trim() : null;
}

async function registrarNaMemoria(chatId, autor, texto) {
    const mem = await carregarMemoriaContato(chatId);
    if (!Array.isArray(mem.mensagens)) mem.mensagens = [];
    if (!Array.isArray(mem.temasVistos)) mem.temasVistos = [];

    if (autor === 'cliente' && !mem.nomeIdentificado) {
        const nomePossivel = tentarCapturarNome(texto);
        if (nomePossivel) {
            mem.nomeIdentificado = nomePossivel;
        }
    }

    mem.atualizadoEm = new Date().toLocaleString('pt-BR');
    mem.mensagens.push({
        autor,
        texto,
        hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    });
    if (mem.mensagens.length > 16) {
        mem.mensagens = mem.mensagens.slice(-16);
    }
    await salvarMemoriaContato(chatId);
}

async function gerarBreveLeitura(chatId) {
    const mem = await carregarMemoriaContato(chatId);
    if (!mem.mensagens.length) {
        return 'Ainda não temos histórico anterior registrado nesta conversa.';
    }

    const falasCliente = mem.mensagens
        .filter((m) => m.autor === 'cliente')
        .slice(-3)
        .map((m) => `"${m.texto}"`);

    const partes = [];
    if (mem.nomeIdentificado) partes.push(`Nome: ${mem.nomeIdentificado}`);
    if (mem.temasVistos.length) partes.push(`Temas vistos: ${mem.temasVistos.join(', ')}`);
    if (mem.fluxoAtual && mem.fluxoAtual !== 'MENU') partes.push(`Triagem em andamento: ${mem.fluxoAtual}`);
    if (falasCliente.length) partes.push(`Últimas mensagens: ${falasCliente.join(' | ')}`);

    return `Resumo da nossa conversa até aqui:\n• ${partes.join('\n• ')}`;
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
        '📋': ' menu ',
        '🙏': ' obrigado '
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
        [/\bresum\b|\bresumo\b|\bhistorico\b|\bja falei\b|\bja conversamos\b|\bonde paramos\b|\bcontinuar\b|\bcontinua\b/g, 'resumo'],
        [/\bobrigad[oa]\b|\bvaleu\b|\bbrigad[oa]\b/g, 'obrigado']
    ];

    for (const [regex, substituto] of substituicoes) {
        limpo = limpo.replace(regex, substituto);
    }

    return limpo
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function analisarIntencaoLocal(textoNormalizado) {
    if (!textoNormalizado) return { intencao: null, confianca: 0 };

    if (/\b(limpar memoria|zerar memoria|apagar memoria|zerar)\b/.test(textoNormalizado)) {
        return { intencao: 'LIMPAR_MEMORIA', confianca: 1 };
    }
    if (/\bresumo\b/.test(textoNormalizado)) {
        return { intencao: 'RESUMO', confianca: 1 };
    }
    if (/^obrigado(\s+saudacao)?$/.test(textoNormalizado)) {
        return { intencao: 'AGRADECIMENTO', confianca: 1 };
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

function extrairDadosTriagem(textoOriginal, textoNormalizado, chatId, nomeMemoria = null) {
    const fallbackNome = nomeMemoria || `Cliente WhatsApp (${chatId.split('@')[0].slice(-6)})`;
    const nomeCapturado = tentarCapturarNome(textoOriginal);
    const nome = nomeCapturado || fallbackNome;

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

async function responderHumanizado(chatId, textoOriginal, sessao, salvarRegistroFn) {
    const textoNormalizado = normalizarTexto(textoOriginal);
    const mem = await carregarMemoriaContato(chatId);
    const analise = analisarIntencaoLocal(textoNormalizado);

    if (analise.intencao === 'LIMPAR_MEMORIA') {
        await limparMemoriaContato(chatId);
        sessao.etapa = 'MENU';
        sessao.dados = {};
        return MENSAGENS.MEMORIA_LIMPA;
    }

    if (analise.intencao === 'RESUMO') {
        return gerarBreveLeitura(chatId);
    }

    if (analise.intencao === 'AGRADECIMENTO') {
        const nomeParte = mem.nomeIdentificado ? `, ${mem.nomeIdentificado}` : '';
        return `Por nada${nomeParte}! Se precisar de mais alguma coisa ou quiser ver as opções, é só chamar ou digitar *menu*.`;
    }

    const ehSaudacaoSimples = /\bsaudacao\b/.test(textoNormalizado) && textoNormalizado.split(' ').length <= 3;
    if (ehSaudacaoSimples && mem.mensagens.length > 2) {
        const leitura = await gerarBreveLeitura(chatId);
        const nomeParte = mem.nomeIdentificado ? ` ${mem.nomeIdentificado}` : '';
        return `Oi${nomeParte}! Que bom falar com você de novo.\n\n${leitura}\n\nQuer continuar por aqui ou ver outras opções? (Digite *1* a *5* ou *menu*)`;
    }

    if (analise.intencao === 'MENU') {
        sessao.etapa = 'MENU';
        sessao.dados = {};
        mem.fluxoAtual = 'MENU';
        await salvarMemoriaContato(chatId);
        return MENSAGENS.MENU;
    }

    const emTriagem = ['CRAS_ANDAMENTO', 'SCFV_ANDAMENTO', 'PARTICULAR_ANDAMENTO'].includes(sessao.etapa);

    if (emTriagem) {
        if (analise.intencao === 'VALORES') {
            if (!mem.temasVistos.includes('Valores')) mem.temasVistos.push('Valores');
            await salvarMemoriaContato(chatId);
            return `${MENSAGENS.VALORES}\n\nQuando quiser, me envie os dados da sua triagem por aqui também.`;
        }
        if (analise.intencao === 'HORARIOS') {
            if (!mem.temasVistos.includes('Horarios')) mem.temasVistos.push('Horarios');
            await salvarMemoriaContato(chatId);
            return `${MENSAGENS.HORARIOS}\n\nQuando quiser, me envie os dados da sua triagem por aqui também.`;
        }

        const extraidos = extrairDadosTriagem(textoOriginal, textoNormalizado, chatId, mem.nomeIdentificado);
        if (extraidos.nome && !extraidos.nome.startsWith('Cliente WhatsApp')) {
            mem.nomeIdentificado = extraidos.nome;
        }

        await salvarRegistroFn({
            tipo: sessao.dados.tipo,
            nome: extraidos.nome,
            telefone: chatId.split('@')[0],
            numerosDetectados: extraidos.numerosDetectados,
            temDocumento: extraidos.temDocumento,
            detalhes: textoOriginal,
            textoNormalizado,
            origem: 'whatsapp'
        });

        sessao.etapa = 'MENU';
        sessao.dados = {};
        mem.fluxoAtual = 'MENU';
        await salvarMemoriaContato(chatId);
        return MENSAGENS.TRIAGEM_SALVA(extraidos.nome);
    }

    if (analise.intencao === 'CRAS') {
        sessao.etapa = 'CRAS_ANDAMENTO';
        sessao.dados = { tipo: 'CRAS' };
        mem.fluxoAtual = 'CRAS_ANDAMENTO';
        if (!mem.temasVistos.includes('CRAS')) mem.temasVistos.push('CRAS');
        await salvarMemoriaContato(chatId);
        return MENSAGENS.CRAS;
    }

    if (analise.intencao === 'SCFV') {
        sessao.etapa = 'SCFV_ANDAMENTO';
        sessao.dados = { tipo: 'SCFV Idosos' };
        mem.fluxoAtual = 'SCFV_ANDAMENTO';
        if (!mem.temasVistos.includes('SCFV Idosos')) mem.temasVistos.push('SCFV Idosos');
        await salvarMemoriaContato(chatId);
        return MENSAGENS.SCFV;
    }

    if (analise.intencao === 'PARTICULAR') {
        sessao.etapa = 'PARTICULAR_ANDAMENTO';
        sessao.dados = { tipo: 'Particular' };
        mem.fluxoAtual = 'PARTICULAR_ANDAMENTO';
        if (!mem.temasVistos.includes('Particular')) mem.temasVistos.push('Particular');
        await salvarMemoriaContato(chatId);
        return MENSAGENS.PARTICULAR;
    }

    if (analise.intencao === 'VALORES') {
        if (!mem.temasVistos.includes('Valores')) mem.temasVistos.push('Valores');
        await salvarMemoriaContato(chatId);
        return MENSAGENS.VALORES;
    }

    if (analise.intencao === 'HORARIOS') {
        if (!mem.temasVistos.includes('Horarios')) mem.temasVistos.push('Horarios');
        await salvarMemoriaContato(chatId);
        return MENSAGENS.HORARIOS;
    }

    if (ehSaudacaoSimples || mem.mensagens.length <= 2) {
        return MENSAGENS.MENU;
    }

    const ultimoTema = mem.temasVistos.length ? mem.temasVistos[mem.temasVistos.length - 1] : null;
    return MENSAGENS.NAO_ENTENDI_COM_CONTEXTO(mem.nomeIdentificado, ultimoTema);
}

module.exports = {
    carregarMemoriaContato,
    salvarMemoriaContato,
    registrarNaMemoria,
    responderHumanizado
};