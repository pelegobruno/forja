const mensagensDiv = document.getElementById('chat-messages');
const inputArea = document.getElementById('chat-input-area');

let estadoAtual = 'INICIO';
let dadosCliente = { tipo: '', nome: '', detalhes: '', horario: '' };

const horariosBase = [
    "Segunda-feira • 14h", "Segunda-feira • 15h", "Segunda-feira • 16h",
    "Terça-feira • 9h", "Terça-feira • 10h", "Terça-feira • 14h",
    "Quarta-feira • 14h", "Quarta-feira • 15h", "Quarta-feira • 17h",
    "Quinta-feira • 9h", "Quinta-feira • 10h", "Quinta-feira • 15h",
    "Sexta-feira • 9h", "Sexta-feira • 14h"
];

function adicionarMensagem(texto, remetente) {
    const div = document.createElement('div');
    div.classList.add('message', remetente);
    div.innerHTML = texto.replace(/\n/g, '<br>');
    mensagensDiv.appendChild(div);
    mensagensDiv.scrollTop = mensagensDiv.scrollHeight;
}

// Simula a secretária "digitando" com atraso de tempo ajustável (em milissegundos)
function adicionarMensagemComAtraso(texto, remetente, tempo = 1000) {
    return new Promise(resolve => {
        setTimeout(() => {
            adicionarMensagem(texto, remetente);
            resolve();
        }, tempo);
    });
}

async function iniciarFluxo() {
    await adicionarMensagemComAtraso("Ola. Seja bem-vindo ao Instituto Forja. Agradecemos seu contato. Para direcionarmos seu atendimento de forma correta, selecione abaixo a opção desejada clicando em um dos botões.", 'bot', 800);
    mostrarOpcoesInicio();
}

function mostrarOpcoesInicio() {
    inputArea.innerHTML = `
        <div class="options-group">
            <button class="btn-opcao" onclick="selecionarOpcao(1)">1 - Encaminhamento pelo CRAS</button>
            <button class="btn-opcao" onclick="selecionarOpcao(2)">2 - SCFV Idosos (60+)</button>
            <button class="btn-opcao" onclick="selecionarOpcao(3)">3 - Atendimento Psicologico Particular</button>
        </div>
    `;
}

async function selecionarOpcao(opcao) {
    if (opcao === 1) {
        dadosCliente.tipo = "CRAS";
        adicionarMensagem("1 - Encaminhamento pelo CRAS", 'user');
        inputArea.innerHTML = '';
        await adicionarMensagemComAtraso("Opcao selecionada: Atendimento por encaminhamento do CRAS. Para darmos inicio ao processo, digite o seu nome completo:", 'bot', 1200);
        estadoAtual = 'CRAS_NOME';
        prepararInputTexto('Digite seu nome completo...');
    } else if (opcao === 2) {
        dadosCliente.tipo = "SCFV Idosos";
        adicionarMensagem("2 - SCFV Idosos", 'user');
        inputArea.innerHTML = '';
        await adicionarMensagemComAtraso("Opcao selecionada: SCFV - Servico de Convivencia e Fortalecimento de Vinculos para Pessoas Idosas. Digite o nome completo da pessoa idosa interessada:", 'bot', 1200);
        estadoAtual = 'SCFV_NOME';
        prepararInputTexto('Nome completo da pessoa idosa...');
    } else if (opcao === 3) {
        dadosCliente.tipo = "Particular";
        adicionarMensagem("3 - Atendimento Psicologico Particular", 'user');
        inputArea.innerHTML = '';
        await adicionarMensagemComAtraso("Opcao selecionada: Atendimento Psicologico Particular pela RAF. Para prosseguir, digite o nome completo de quem vai receber o atendimento:", 'bot', 1200);
        estadoAtual = 'PARTICULAR_NOME';
        prepararInputTexto('Nome completo do paciente...');
    }
}

function prepararInputTexto(placeholder) {
    inputArea.innerHTML = `
        <div class="input-text-group">
            <input type="text" id="userInput" placeholder="${placeholder}" autofocus>
            <button onclick="enviarTexto()">Enviar</button>
        </div>
    `;
    document.getElementById('userInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') enviarTexto();
    });
}

async function enviarTexto() {
    const input = document.getElementById('userInput');
    const valor = input.value.trim();
    if (!valor) return;

    adicionarMensagem(valor, 'user');
    input.value = '';
    inputArea.innerHTML = '';

    if (estadoAtual === 'CRAS_NOME') {
        dadosCliente.nome = valor;
        await adicionarMensagemComAtraso("Informe a quantidade de filhos que moram com voce e a idade de cada um deles:", 'bot', 1200);
        estadoAtual = 'CRAS_FILHOS';
        prepararInputTexto('Ex: 2 filhos (5 e 8 anos)');
    } else if (estadoAtual === 'CRAS_FILHOS') {
        dadosCliente.detalhes = `Filhos e idades: ${valor}`;
        finalizarAtendimento();
    } else if (estadoAtual === 'SCFV_NOME') {
        dadosCliente.nome = valor;
        await adicionarMensagemComAtraso("Informe a idade da pessoa idosa e tambem o nome e o telefone do familiar ou responsavel:", 'bot', 1200);
        estadoAtual = 'SCFV_DETALHES';
        prepararInputTexto('Idade, nome e telefone...');
    } else if (estadoAtual === 'SCFV_DETALHES') {
        dadosCliente.detalhes = `Detalhes do idoso e responsavel: ${valor}`;
        finalizarAtendimento();
    } else if (estadoAtual === 'PARTICULAR_NOME') {
        dadosCliente.nome = valor;
        await adicionarMensagemComAtraso("Informe a idade do paciente e se procura atendimento para si mesmo ou para outra pessoa:", 'bot', 1200);
        estadoAtual = 'PARTICULAR_IDADE';
        prepararInputTexto('Idade e para quem...');
    } else if (estadoAtual === 'PARTICULAR_IDADE') {
        dadosCliente.detalhes = `Idade e vinculo: ${valor}`;
        mostrarTextoAvaliacao();
    }
}

async function mostrarTextoAvaliacao() {
    await adicionarMensagemComAtraso("O Instituto Forja, por meio da Rede de Atendimento Forja, oferece atendimento psicologico acessivel. O primeiro passo e realizar uma avaliacao inicial no valor de R$ 70,00.\n\nEsse encontro serve para conhecer suas necessidades e estruturar um plano terapeutico adequado. Deseja verificar os horarios disponiveis para essa avaliacao?", 'bot', 1500);
    
    inputArea.innerHTML = `
        <div class="options-group">
            <button class="btn-opcao" onclick="carregarAgendaValidada()">Sim, quero ver os horarios disponiveis</button>
        </div>
    `;
}

// Momento em que a secretária consulta a agenda para ver o que já foi ocupado
async function carregarAgendaValidada() {
    adicionarMensagem("Sim, quero ver os horarios disponiveis", 'user');
    inputArea.innerHTML = '';
    
    await adicionarMensagemComAtraso("Consultando a agenda do Instituto Forja em tempo real...", 'bot', 800);

    // Faz a requisição no servidor para ver os agendamentos já salvos
    fetch('/api/agendamentos')
        .then(res => res.json())
        .then(registros => {
            // Filtra quais horários já foram escolhidos por outras pessoas
            const horariosOcupados = registros.map(item => item.horario).filter(Boolean);
            
            // Mantém apenas os horários que NÃO estão na lista de ocupados
            const horariosLivres = horariosBase.filter(h => !horariosOcupados.includes(h));

            if (horariosLivres.length === 0) {
                adicionarMensagem("No momento nao temos horarios disponiveis na agenda. Nossa equipe entrará em contato.", 'bot');
                return;
            }

            adicionarMensagem("Selecione abaixo a melhor opcao de dia e horario disponivel:", 'bot');

            let htmlOpcoes = '<div class="options-group" style="max-height: 200px; overflow-y: auto;">';
            horariosLivres.forEach((h) => {
                htmlOpcoes += `<button class="btn-opcao" onclick="escolherHorario('${h}')">${h}</button>`;
            });
            htmlOpcoes += '</div>';
            inputArea.innerHTML = htmlOpcoes;
        })
        .catch(() => {
            adicionarMensagem("Erro ao carregar a agenda. Tente novamente.", 'bot');
        });
}

function escolherHorario(horario) {
    dadosCliente.horario = horario;
    adicionarMensagem(`Horario escolhido: ${horario}`, 'user');
    inputArea.innerHTML = '';

    setTimeout(async () => {
        await adicionarMensagemComAtraso(`Perfeito. Para garantir a reserva do seu horario (${horario}), a avaliacao inicial no valor de R$ 70,00 deve ser paga antecipadamente.\n\nFormas de pagamento:\n- Via PIX: Solicite a chave no WhatsApp.\n- Presencialmente na sede do Instituto Forja.\n\nAssim que o pagamento for realizado, clique no botao abaixo para enviar o comprovante diretamente no WhatsApp da nossa equipe.`, 'bot', 1200);
        
        // SALVA O REGISTRO IMEDIATAMENTE PARA O ADMIN VISUALIZAR E BLOQUEAR O HORÁRIO
        fetch('/api/salvar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dadosCliente)
        });

        inputArea.innerHTML = `
            <div class="options-group">
                <button class="btn-opcao" style="background: #25d366;" onclick="window.open('https://wa.me/555184505307?text=Ola, realizei o agendamento pelo sistema para o horario ${dadosCliente.horario} em nome de ${dadosCliente.nome} e gostaria de enviar o comprovante do pagamento.', '_blank')">Enviar Comprovante no WhatsApp</button>
            </div>
        `;
    }, 1000);
}

async function finalizarAtendimento() {
    // SALVA O REGISTRO DO CRAS OU SCFV PARA O ADMIN
    fetch('/api/salvar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dadosCliente)
    });

    await adicionarMensagemComAtraso("Recebemos suas informacoes com sucesso. Nossa equipe entrara em contato por aqui para dar sequencia ao seu atendimento. Obrigado.", 'bot', 1200);
    inputArea.innerHTML = `<p style="text-align:center; font-size:0.9rem; color:#555; padding:8px;">Atendimento finalizado com sucesso.</p>`;
}

iniciarFluxo();