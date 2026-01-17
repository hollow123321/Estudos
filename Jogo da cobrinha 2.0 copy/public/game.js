const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const socket = io();

// Elementos da UI (IDs conferidos com index.html)
const lobbyScreen = document.getElementById('lobby-screen');
const loginButton = document.getElementById('btn-entrar');
const nomeInput = document.getElementById('input-nome');
const errorMessage = document.getElementById('error-message');
const scoreBoard = document.getElementById('score-board');
const pingDisplay = document.getElementById('ping');

// Estado do Jogo
let myId = null; // ID do meu jogador (socket.id)
let isPlaying = false; // CRÍTICO: flag de controle para saber se estamos jogando ou no lobby
let players = {}; // Estado bruto vindo do servidor
let playersInterpolated = {}; // Estado visual suavizado para renderização (interpolação)
let lastMyState = null; // Para uso futuro (dedução de eventos, etc)
let foods = []; // Lista de frutas/comidas

let fireHazards = []; // Perigos de fogo (Lava)
let smokeClouds = []; // Nuvens de fumaça (Fog of War)
let visualEffects = []; // Sistema de Efeitos Visuais (VFX) locais
let pendingInputs = []; // Fila de inputs
let inputSequence = 0; // Sequenciador de inputs para reconciliação

// Configurações Iniciais (Padrões)
let TILE_SIZE = 20;
let MAP_WIDTH = 800; // Será sobrescrito pelo servidor ao entrar
let MAP_HEIGHT = 600;

// --- 1. LÓGICA DE LOBBY ---

// --- Lógica do Seletor de Cores ---
let selectedColor = '#00ff88'; // Cor padrão
const colorOptions = document.querySelectorAll('.color-option');

colorOptions.forEach(opt => {
    opt.addEventListener('click', () => {
        // Remove seleção visual de todas
        colorOptions.forEach(o => o.classList.remove('selected'));
        // Adiciona na clicada
        opt.classList.add('selected');
        // Atualiza estado
        selectedColor = opt.dataset.color;
    });
});

const joinGame = () => {
    const nome = nomeInput.value.trim();
    if (nome) {
        // Bloqueia UI enquanto conecta
        loginButton.disabled = true;
        loginButton.innerText = "Conectando...";
        
        // Emite evento de entrada enviando Nome e Cor escolhida
        socket.emit('joinGame', { name: nome, color: selectedColor });
        
        // [NOVO] Inicia música ao interagir
        if (window.AudioManager) window.AudioManager.startMusic();
    } else {
        errorMessage.innerText = "Digite um nickname válido!";
    }
};

loginButton.addEventListener('click', joinGame);
nomeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinGame();
});

// [NOVO] Botão de Mudo
const btnMute = document.getElementById('btn-mute');
if (btnMute) {
    btnMute.addEventListener('click', () => {
        const isMuted = !window.AudioManager.toggleMute();
        btnMute.innerText = isMuted ? '🔇' : '🔊';
        // Remove foco para evitar que o Espaço acione o botão novamente
        btnMute.blur();
    });
}

// Ouvinte GLOBAL para teclas Especiais (Barra de Espaço para Dash)
window.addEventListener('keydown', (e) => {
    if (!isPlaying) return;
    if (e.code === 'Space') {
        socket.emit('dash');
    }
});

// Resposta: Tocar Som vindo do Servidor
socket.on('playSound', (soundKey) => {
      if (window.AudioManager) window.AudioManager.play(soundKey);
});

// Resposta: Sucesso ao entrar no jogo
socket.on('gameJoined', (config) => {
    console.log("Entrou no jogo!", config);
    myId = config.id;
    TILE_SIZE = config.tileSize || 20;
    
    // Atualiza dimensões do mapa com o que veio do servidor
    MAP_WIDTH = config.width || 1600;
    MAP_HEIGHT = config.height || 1200;
    
    canvas.width = MAP_WIDTH;
    canvas.height = MAP_HEIGHT;
    
    // Função de Auto-Redimensionamento (Zoom/Fit na tela)
    const resizeGame = () => {
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        // Calcula a escala para caber na tela mantendo proporção
        const scale = Math.min(winW / MAP_WIDTH, winH / MAP_HEIGHT);
        
        canvas.style.width = `${MAP_WIDTH * scale}px`;
        canvas.style.height = `${MAP_HEIGHT * scale}px`;
    };
    
    window.addEventListener('resize', resizeGame);
    resizeGame(); // Chamada inicial
    
    // Esconde Lobby e inicia estado de jogo
    lobbyScreen.classList.add('hidden');
    isPlaying = true;
    
    // Limpa erro e reseta botão (caso jogador volte ao lobby depois)
    errorMessage.innerText = "";
    loginButton.disabled = false;
    loginButton.innerText = "ENTRAR AGORA";
    
    // Foca na janela para inputs do teclado funcionarem imediatamente
    window.focus();
});

// Resposta: Erro ao entrar (ex: servidor cheio)
socket.on('joinError', (msg) => {
    alert(msg); // Ou mostrar no texto
    errorMessage.innerText = msg;
    loginButton.disabled = false;
    loginButton.innerText = "ENTRAR AGORA";
});

// Resposta: Game Over (Você morreu)
socket.on('gameOver', (data) => {
    console.log("Game Over");
    
    isPlaying = false;
    
    // Mostra Lobby de novo
    lobbyScreen.classList.remove('hidden');
    document.getElementById('input-nome').focus(); // Foca input para jogar rápido
    
    // Feedback de Morte e Score
    const score = data && data.score ? data.score : 0;
    errorMessage.innerHTML = `VOCÊ MORREU! <br> Score Final: ${score}`;
    errorMessage.style.color = '#ff4444'; 
    
    // Limpa estado local dos players
    players = {};
    playersInterpolated = {};
    lastMyState = null;
});

// Recebimento de Estado do Servidor (Foods/Players/Hazards)
// Ocorre aprox 15-20 vezes por segundo (Tick Rate)
socket.on('state', (pack) => {
    const oldFoods = foods || []; // Armazena estado anterior para verificar mudanças (diff)
    foods = pack.f || [];
    fireHazards = pack.h || [];
    smokeClouds = pack.s || []; // Nuvens de fumaça
    
    // --- DETECTAR REMOÇÃO DE BURACÃO NEGRO (VFX) ---
    oldFoods.forEach(oldF => {
        if (oldF.type === 'blackhole') {
            // Verifica se este blackhole sumiu nesta atualização
            // Verifica se ainda existe uma comida na mesma posição e tipo.
            const stillExists = foods.find(f => f.x === oldF.x && f.y === oldF.y && f.type === 'blackhole');
            if (!stillExists) {
                // Criar Efeito Visual Persistente (Animação de fechar)
                visualEffects.push({
                    x: oldF.x,
                    y: oldF.y,
                    type: 'blackhole_close',
                    startTime: Date.now(),
                    duration: 1200 // 1.2s total (Pulsar -> Fechar)
                });
            }
        }
    });

    const serverPlayers = pack.p || [];
    const serverIds = serverPlayers.map(p => p.i);

    // Atualiza ou Cria players locais
    serverPlayers.forEach(p => {
        // Se ainda não temos esse player localmente
        if (!players[p.i]) {
            players[p.i] = p;
            // Cria cópia profunda para interpolação visual independente
            playersInterpolated[p.i] = JSON.parse(JSON.stringify(p));
        } else {
            // Atualiza o player alvo (Target) com dados novos
            players[p.i] = p;
        }

        // Reconciliação do PRÓPRIO player (Correção de posição cliente x servidor)
        if (isPlaying && p.i === myId) {
            
            // Atualiza último estado conhecido
            lastMyState = { x: p.x, y: p.y, s: p.s, dash: p.dash, b: JSON.parse(JSON.stringify(p.b || [])) };

            const pVisual = playersInterpolated[myId];
            if (pVisual) {
                // Distância entre visual e server
                const dx = Math.abs(pVisual.x - p.x);
                const dy = Math.abs(pVisual.y - p.y);
                
                // Se erro > 40px (2 blocos), corrige forçado (snap), senão interpola suave
                if (dx > 40 || dy > 40) {
                    pVisual.x = p.x;
                    pVisual.y = p.y;
                }
                
                // Sincroniza corpo e score sempre
                pVisual.b = p.b;
                pVisual.score = p.s;
            }
        }
    });

    // Remove jogadores desconectados
    for (let id in players) {
        if (!serverIds.includes(id)) {
            delete players[id];
            delete playersInterpolated[id];
        }
    }
    
    updateLeaderboard();
});

// --- 2. GERENCIAMENTO DE INPUT ---
const keyMap = {
    'ArrowUp': 'UP',
    'ArrowDown': 'DOWN',
    'ArrowLeft': 'LEFT',
    'ArrowRight': 'RIGHT' 
};

// Fila de Entrada para evitar "flood" e giros impossíveis
let inputQueue = [];

// Ouve teclas pressionadas
window.addEventListener('keydown', (e) => {
    if (!isPlaying) return; 
    
    const dirName = keyMap[e.key];
    if (!dirName) return;
    
    // Adiciona na fila para ser processado no ritmo do render/tick
    inputQueue.push(dirName);
});

// --- AUXILIARES VISUAIS (VFX) ---

/**
 * Desenha uma fruta com estilo Premium/Neon
 */
function drawFruit(ctx, f) {
    const cx = f.x + TILE_SIZE / 2;
    const cy = f.y + TILE_SIZE / 2;
    const r = (TILE_SIZE / 2) - 1;

    ctx.save();

    // Cores Base e Sombra (Glow)
    let shadowColor = '#ff4400';
    let baseColor = '#ff0055';
    let type = f.type || 'food';

    // Configurações visuais específicas por tipo de fruta
    if (type === 'blueberry') { // AZUL (Crescimento)
        baseColor = '#4488ff';
        shadowColor = '#0055ff';
    } else if (type === 'ghost') { // TRANSPARENTE (Fantasma)
        baseColor = 'rgba(200, 200, 200, 0.4)';
        shadowColor = '#ffffff';
    } else if (type === 'blackhole') { // PRETO E ROXO (Buraco Negro)
        baseColor = '#000000';
        shadowColor = '#8a2be2';
    } else if (type === 'reverse') { // ROSA (Inverter)
        baseColor = '#ff00ff';
        shadowColor = '#ff69b4';
    } else if (type === 'rainbow') { // RGB (Arco-íris)
        const hue = (Date.now() / 5) % 360;
        baseColor = `hsl(${hue}, 100%, 60%)`;
        shadowColor = `hsl(${hue}, 100%, 80%)`;
    } else if (type === 'sluggish') { // VERDE GOSMA (Lentidão)
        baseColor = '#39ff14';
        shadowColor = '#39ff14';
    } else if (type === 'dash') { // ROXO VELOZ (Dash)
        baseColor = '#bc13fe';
        shadowColor = '#d500f9';
    } else if (type === 'cyan') { // CIANO (Congelar Tempo)
        baseColor = '#00ffff';
        shadowColor = '#00ffff';
    } else if (type === 'orange') { // LARANJA (Fogo/Lava)
        baseColor = '#ff6600';
        shadowColor = '#ff3300';
    } else if (type === 'immunity') { // VERDE ESCURO (Escudo/Imunidade)
        baseColor = '#006400';
        shadowColor = '#00ff00';
    } else if (type === 'death_drop') { // VERMELHO PISCANTE (Resto mortal)
        const blink = Math.floor(Date.now() / 100) % 2 === 0;
        baseColor = blink ? '#ff0000' : '#880000';
        shadowColor = '#ff0000';
    } else if (type === 'predator') { // AZUL PETRÓLEO (Predador)
        baseColor = '#008080';
        shadowColor = '#00ffff';
    } else if (type === 'smoke') { // FUMAÇA BRANCA
        baseColor = '#eeeeee';
        shadowColor = '#aaaaaa';
    }

    // Efeito de Glow Neon
    ctx.shadowBlur = 15;
    ctx.shadowColor = shadowColor;

    // Desenha o corpo da fruta (Esfera com Gradiente)
    const grad = ctx.createRadialGradient(cx - r/3, cy - r/3, r/5, cx, cy, r);
    grad.addColorStop(0, '#ffffff'); // Brilho especular no topo
    grad.addColorStop(0.3, baseColor);
    grad.addColorStop(1, shadowColor); // Borda mais saturada

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // Detalhes Específicos Adicionais
    ctx.shadowBlur = 0; // Reset para detalhes nítidos
    
    // Anel orbital para Blackhole
    if (type === 'blackhole') {
         ctx.strokeStyle = '#dda0dd';
         ctx.lineWidth = 2;
         ctx.beginPath();
         ctx.arc(cx, cy, r * 0.6, 0, Math.PI*2);
         ctx.stroke();
    }
    // Olhos "Maus" para Predador ou Drop Morto
    if (type === 'predator' || type === 'death_drop') {
        ctx.fillStyle = '#000';
        ctx.beginPath();
        // Carinha brava
        ctx.arc(cx - 3, cy - 2, 2, 0, Math.PI*2);
        ctx.arc(cx + 3, cy - 2, 2, 0, Math.PI*2);
        ctx.fill();
    }

    ctx.restore();
}

/**
 * Desenha Olhos na Cabeça da Cobra
 */
function drawSnakeEyes(ctx, headX, headY, angle, pTarget) {
    const eyeOffset = 5; // Distância do centro para os lados
    const eyeForward = 4; // Distância para frente
    const eyeSize = 3.5;

    // Cores dos Olhos (Reativos ao Estado)
    let eyeColor = '#ffffff'; // Normal
    let pupilColor = '#000000';

    if (pTarget.predator) {
        eyeColor = '#ff0000'; // Olhos vermelhos (Caçador)
        pupilColor = '#ffff00';
    } else if (pTarget.immune) {
        eyeColor = '#ffff00'; // Olhos Dourados (Imune)
    } else if (pTarget.eff === 'sluggish' || pTarget.eff === 'freeze') {
        eyeColor = '#00ffff'; // Olhos Ciano (Congelado/Lento)
    }

    ctx.save();
    
    // Rotacionar o contexto para facilitar o desenho baseado no ângulo da cabeça
    ctx.translate(headX, headY);
    ctx.rotate(angle);

    ctx.fillStyle = eyeColor;
    
    // Olho Esquerdo
    ctx.beginPath();
    ctx.arc(eyeForward, -eyeOffset, eyeSize, 0, Math.PI*2);
    ctx.fill();
    
    // Olho Direito
    ctx.beginPath();
    ctx.arc(eyeForward, eyeOffset, eyeSize, 0, Math.PI*2);
    ctx.fill();

    // Pupilas
    ctx.fillStyle = pupilColor;
    ctx.beginPath();
    ctx.arc(eyeForward + 1, -eyeOffset, 1.5, 0, Math.PI*2); // Olhando levemente pra frente
    ctx.arc(eyeForward + 1, eyeOffset, 1.5, 0, Math.PI*2);
    ctx.fill();

    ctx.restore();
}

// --- 3. LOOP DE RENDERIZAÇÃO (MODERNIZADO) ---
function render() {
    // 1. Processamento de Input
    if (inputQueue.length > 0 && playersInterpolated[myId]) {
        const dirName = inputQueue.shift();
        
        inputSequence++;
        const pVisual = playersInterpolated[myId];
        
        // Envia input para o servidor
        socket.emit('input', {
            dir: dirName,
            x: pVisual.x,
            y: pVisual.y,
            seq: inputSequence
        });
    }

    // 2. Limpa Tela & Desenha Fundo
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Grid Moderno (Linhas sutis)
    ctx.save();
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= MAP_WIDTH; x += TILE_SIZE) {
        ctx.moveTo(x, 0); ctx.lineTo(x, MAP_HEIGHT);
    }
    for (let y = 0; y <= MAP_HEIGHT; y += TILE_SIZE) {
        ctx.moveTo(0, y); ctx.lineTo(MAP_WIDTH, y);
    }
    ctx.stroke();
    
    // Vinheta (Escurecer bordas para foco no centro)
    const grad = ctx.createRadialGradient(
        canvas.width/2, canvas.height/2, Math.min(canvas.width, canvas.height)/2,
        canvas.width/2, canvas.height/2, Math.max(canvas.width, canvas.height)
    );
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = grad;
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.restore();

    // 3. Fire Hazards (Lava/Fogo)
    ctx.save();
    ctx.shadowBlur = 15;
    ctx.shadowColor = '#ff3300';
    ctx.fillStyle = '#ff2200';
    fireHazards.forEach(h => {
        // Efeito de "respiração" (pulsação)
        const pulse = (Math.sin(Date.now() / 200) * 0.2) + 0.8;
        ctx.globalAlpha = pulse;
        
        // Desenha como quadrado arredondado
        const r = 4;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(h.x, h.y, TILE_SIZE, TILE_SIZE, r);
        else ctx.rect(h.x, h.y, TILE_SIZE, TILE_SIZE);
        ctx.fill();
    });
    ctx.restore();

    // 4. Efeitos Visuais (VFX Layer - Abaixo da cobra, acima do chão)
    visualEffects = visualEffects.filter(eff => {
        const age = Date.now() - eff.startTime;
        const progress = age / eff.duration;
        
        if (progress >= 1) return false; // Remove efeito se acabou o tempo

        if (eff.type === 'blackhole_close') {
            ctx.save();
            const cx = eff.x + TILE_SIZE/2;
            const cy = eff.y + TILE_SIZE/2;
            const baseR = (TILE_SIZE/2) - 1;
            
            // Animação: 
            // 0% - 60%: Pulsando normal (ainda aberto visualmente)
            // 60% - 100%: Fechando (Diminuindo escala)
            
            let scale = 1;
            if (progress > 0.6) {
                // Mapeia 0.6->1.0 para 1.0->0.0
                scale = 1 - ((progress - 0.6) / 0.4);
            }
            
            const r = baseR * scale;
            
            ctx.shadowBlur = 15 * scale;
            ctx.shadowColor = '#8a2be2';
            
            // Anel externo
            ctx.strokeStyle = `rgba(221, 160, 221, ${scale})`;
            ctx.lineWidth = 2 * scale;
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.8, 0, Math.PI*2);
            ctx.stroke();

            // Miolo preto
            ctx.fillStyle = '#000';
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI*2);
            ctx.fill();

            // Pulso interno Roxo
            const pulse = Math.sin(age * 0.01) * 0.2 + 0.8;
            ctx.fillStyle = `rgba(138, 43, 226, ${0.5 * scale * pulse})`;
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.5 * pulse, 0, Math.PI*2);
            ctx.fill();

            ctx.restore();
        }
        
        return true; // Mantém o efeito
    });

    // 5. Frutas
    foods.forEach(f => {
        drawFruit(ctx, f);
    });

    // 6. Jogadores (Renderização da Cobra "Seamless"/Contínua)
    for (let id in playersInterpolated) {
        let pVisual = playersInterpolated[id];
        let pTarget = players[id];
        
        if (!pVisual || !pTarget) continue;

        // Visual Interpolação (Suavização de Movimento)
        const lerpFactor = (id === myId) ? 0.2 : 0.1;
        pVisual.x += (pTarget.x - pVisual.x) * lerpFactor;
        pVisual.y += (pTarget.y - pVisual.y) * lerpFactor;

        // Configuração de Cores & Efeitos
        ctx.save();
        let snakeColor = pVisual.c || '#fff'; // Cor padrão branca se falhar
        let glowColor = snakeColor;
        let glowSize = 10;

        // Overrides de Cor por Efeito (Prioridade Visual)
        if (pTarget.predator) {
            snakeColor = '#008080';
            glowColor = '#00ffff';
            glowSize = 20;
        } else if (pTarget.immune) {
            snakeColor = '#006400';
            glowColor = '#00ff00';
        } else if (pTarget.eff === 'rainbow') { // Efeito Rainbow
            const hue = (Date.now() / 2) % 360;
            snakeColor = `hsl(${hue}, 100%, 60%)`;
            glowColor = snakeColor;
        } else if (pTarget.eff === 'sluggish') { // Efeito Lentidão (Pisca cinza)
             if (Math.floor(Date.now() / 250) % 2 === 0) {
                 snakeColor = '#888888';
                 glowColor = '#888888';
             }
        }

        // Modo Fantasma (Translucidez)
        if (pTarget.inv) {
            if (id === myId) ctx.globalAlpha = 0.4; // Jogador vê a si mesmo translúcido
            else ctx.globalAlpha = 0.0; // Totalmente invisível para inimigos
        }

        // Configura Caneta para Corpo Seamless (Redondo e Conectado)
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = TILE_SIZE - 2; // Um pouco menor que o tile pra não colar demais nas paredes
        ctx.strokeStyle = snakeColor;
        ctx.shadowBlur = glowSize;
        ctx.shadowColor = glowColor;

        // Desenha Caminho do Corpo
        if (pTarget.b && pTarget.b.length > 0) {
            
            // Cabeça (Interpolada)
            const headCx = pVisual.x + TILE_SIZE/2;
            const headCy = pVisual.y + TILE_SIZE/2;

            // RASTREADOR PARA RENDERIZAÇÃO INTELIGENTE COM DASH (GHOST SEGMENTS)
            // Divide o corpo em sub-caminhos baseados se o segmento é fantasma ou não
            
            let currentPath = []; // Pontos do caminho atual {x, y}
            let isCurrentGhost = false; // Estado atual do path (se é ghost ou sólido)

            // Adiciona Cabeça ao local atual (Ponto inicial)
            currentPath.push({x: headCx, y: headCy});
            
            // Função auxiliar para desenhar o path acumulado
            const flushPath = (isGhost, pathPoints) => {
                if (pathPoints.length < 2) return; // Precisa de 2 pontos para uma linha

                ctx.beginPath();
                ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
                for(let k=1; k<pathPoints.length; k++) {
                    ctx.lineTo(pathPoints[k].x, pathPoints[k].y);
                }

                ctx.save();
                if (isGhost) {
                    ctx.globalAlpha = 0.3; // Segmentos fantasmas (Rastro do dash)
                    ctx.shadowBlur = 0; // Remove brilho para não poluir
                }
                ctx.stroke(); // Desenha a linha
                ctx.restore();
            };

            // Percorre segmentos vindos do servidor
            // Começa do índice 1, pois o índice 0 (cabeça) já é tratado interpoladamente acima
            let prevX = headCx;
            let prevY = headCy;

            for(let i=1; i < pTarget.b.length; i++) {
                const part = pTarget.b[i];
                const partCx = part.x + TILE_SIZE/2;
                const partCy = part.y + TILE_SIZE/2;
                
                // Checa Teleporte (Distância Grande entre segmentos adjacentes)
                // Acontece em portais ou wrap (se existisse)
                const dist = Math.abs(partCx - prevX) + Math.abs(partCy - prevY);
                const isTeleport = dist > TILE_SIZE * 3;

                // Propriedade Ghost vinda do servidor (Dash Rastro)
                const isPartGhost = part.isGhost === true;

                if (isTeleport) {
                    // SE HOUVE TELEPORTE:
                    // 1. Desenha o que acumulamos até agora
                    flushPath(isCurrentGhost, currentPath);
                    currentPath = []; // Reseta path
                    
                    // 2. Inicia novo path no novo local
                    currentPath.push({x: partCx, y: partCy});
                    isCurrentGhost = isPartGhost;

                } else {
                    // SE É CONTÍNUO:
                    // Verifica se o estado mudou (ex: Entrou/Saiu de segmento ghost)
                    if (isPartGhost !== isCurrentGhost) {
                        
                        // 1. Adiciona o ponto atual para fechar a conexão visual
                        currentPath.push({x: partCx, y: partCy});
                        
                        // 2. Desenha o path antigo
                        flushPath(isCurrentGhost, currentPath);
                        
                        // 3. Inicia novo path PARTINDO DO PONTO ATUAL (conexão sem buracos)
                        currentPath = [{x: partCx, y: partCy}];
                        isCurrentGhost = isPartGhost;
                        
                    } else {
                        // Mesmo estado, apenas acumula o ponto
                        currentPath.push({x: partCx, y: partCy});
                    }
                }
                
                prevX = partCx;
                prevY = partCy;
            }
            
            // Desenha o que sobrou no buffer no final
            if (currentPath.length > 0) {
                 flushPath(isCurrentGhost, currentPath);
            }

            // Desenha a Cabeça (Círculo sólido preenchido para fechar a ponta)
            ctx.fillStyle = snakeColor;
            ctx.beginPath();
            ctx.arc(headCx, headCy, (TILE_SIZE-2)/2, 0, Math.PI*2);
            ctx.fill();

            // --- OLHOS ---
            let angle = 0;
            if (pTarget.b.length > 1) {
                // Calcula ângulo olhando para o segmento do pescoço
                const neck = pTarget.b[1];
                const dx = headCx - (neck.x + TILE_SIZE/2);
                const dy = headCy - (neck.y + TILE_SIZE/2);
                
                // Evita calcular ângulo errado durante teleporte
                if (Math.abs(dx) < TILE_SIZE * 2 && Math.abs(dy) < TILE_SIZE * 2) {
                     angle = Math.atan2(dy, dx);
                }
            }
            
            ctx.shadowBlur = 0; 
            drawSnakeEyes(ctx, headCx, headCy, angle, pTarget);
        }

        // Desenha Nickname (Nome do Jogador)
        if (pTarget.n) {
            ctx.shadowBlur = 4;
            ctx.shadowColor = '#000';
            ctx.fillStyle = "#fff";
            ctx.font = "bold 12px 'Rajdhani', sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(pTarget.n, pVisual.x + TILE_SIZE/2, pVisual.y - 10);
        }

        ctx.restore();
    }

    // 7. Fog of War (Névoa de Guerra / Fumaça)
    if (playersInterpolated[myId] && smokeClouds.length > 0) {
        const pVisual = playersInterpolated[myId];
        let insideFog = false;

        // Verifica se meu jogador está dentro de alguma nuvem que não é dele
        for(let s of smokeClouds) {
            const dx = pVisual.x - s.x;
            const dy = pVisual.y - s.y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist < s.r && s.ownerId !== myId) {
                insideFog = true;
                break;
            }
        }

        if (insideFog) {
            ctx.save();
            ctx.fillStyle = "rgba(0, 0, 0, 0.999)"; // Escuridão quase total
            
            ctx.beginPath();
            ctx.rect(0, 0, canvas.width, canvas.height); // Cobre a tela toda

            // Recorta um buraco de visão ao redor do jogador
            const clearSize = 6 * TILE_SIZE; 
            const cx = pVisual.x + TILE_SIZE/2;
            const cy = pVisual.y + TILE_SIZE/2;
            
            ctx.arc(cx, cy, clearSize/2, 0, Math.PI*2, true); // Anti-horário cria o furo
            ctx.fill();
            
            // Borda do campo de visão
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cx, cy, clearSize/2, 0, Math.PI*2);
            ctx.stroke();

            ctx.restore();
        }
    }

    requestAnimationFrame(render);
}

// Inicia o Loop de Renderização
requestAnimationFrame(render);

// Auxiliar de Ping (Latência)
setInterval(() => {
    const start = Date.now();
    socket.emit('ping', () => {
        const ms = Date.now() - start;
        if(pingDisplay) pingDisplay.innerText = ms;
    });
}, 2000);

// Função para atualizar o Placar HTML
function updateLeaderboard() {
    if(!scoreBoard) return;
    // Converte objeto de players em array e ordena por score decrescente
    const list = Object.values(players).sort((a,b) => (b.s||0) - (a.s||0));
    let html = '';
    list.forEach(p => {
        // Mostra Nome e Score na cor da cobra
        html += `<div style="color:${p.c}; margin-bottom: 2px;">${p.n}: ${p.s || 0}</div>`;
    });
    scoreBoard.innerHTML = html;
}
