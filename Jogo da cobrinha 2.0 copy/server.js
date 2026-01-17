const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve arquivos estáticos da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// --- CONSTANTES DO JOGO (Configurações Gerais) ---
const TILE_SIZE = 20; // Tamanho do quadrado (tile) em Pixels
const MAP_WIDTH = 1600; // Largura total do mapa
const MAP_HEIGHT = 1200; // Altura total do mapa
const TICK_RATE = 15; // Atualizações por segundo (15 FPS de lógica no servidor)
const TICK_MS = 1000 / TICK_RATE; // Duração de um tick em ms

// --- ESTADO DO JOGO ---
let players = {}; // Players ativos { socketId: PlayerObj }
let foods = []; // Lista de frutas no mapa
let fireHazards = []; // Poças de lava { x, y, expiresAt }
let smokeClouds = []; // Nuvens de fumaça { x, y, r, ownerId, expiresAt }
let freezeEndTime = 0; // Timestamp de quando o congelamento global acaba
let freezeExceptionId = null; // ID do jogador imune ao congelamento (quem pegou a fruta Ciano)

// Auxiliar: Alinha posições aleatórias à grade (Grid)
// Fórmula Obrigatória: x = Math.floor(Math.random() * (MAP_WIDTH / TILE_SIZE)) * TILE_SIZE;
const getRandomCoord = (max) => {
  return Math.floor(Math.random() * (max / TILE_SIZE)) * TILE_SIZE;
};

// --- LÓGICA DE GERAÇÃO DE POWER-UPS (Frutas) ---
// Tipos: 'normal', 'blueberry', 'ghost', 'reverse', 'blackhole', 'rainbow', 'sluggish', 'dash', etc.
const spawnFood = () => {
  // Limite máximo de frutas no mapa
  if (foods.length < 100) { 
     const rand = Math.random() * 100;
     let type = 'normal';
     let isPair = false;

     // Distribuição de Probabilidades (%):
     // 80% Normal (0-80)
     // 5% Blueberry (80-85)
     // 3% Ghost (85-88)
     // 2% Reverse (88-90)
     // 2% Smoke (90-92)
     // 2% Immunity (92-94)
     // 1% Predator (94-95)
     // 1% Cyan (95-96)
     // 1% Orange (96-97)
     // 1% Blackhole (97-98)
     // 2% Outros (Rainbow, Sluggish, Dash) (98-100)

     if (rand < 80) {
         type = 'normal';
     } else if (rand < 85) {
         type = 'blueberry'; // Cresce +5
     } else if (rand < 88) {
         type = 'ghost'; // Fica invisível
     } else if (rand < 90) {
         type = 'reverse'; // Inverte a cobra
     } else if (rand < 92) {
         type = 'smoke'; // Solta fumaça
     } else if (rand < 94) {
         type = 'immunity'; // Escudo
     } else if (rand < 95) {
         type = 'predator'; // Modo caçador
     } else if (rand < 96) {
         type = 'cyan'; // Congela o tempo
     } else if (rand < 97) {
         type = 'orange'; // Rastro de fogo
     } else if (rand < 98) {
         type = 'blackhole'; // Teletransporte
         isPair = true;
     } else {
         // Sub-sorteio para raros restantes
         const subRand = Math.random() * 3;
         if (subRand < 1) type = 'rainbow'; // Cosmético
         else if (subRand < 2) type = 'sluggish'; // Lentidão
         else type = 'dash'; // Super velocidade
     }

     if (isPair && type === 'blackhole') {
         // Spawna um PAR de buracos negros (conectados por ID)
         const pairId = Date.now() + Math.random();
         const posA = { x: getRandomCoord(MAP_WIDTH), y: getRandomCoord(MAP_HEIGHT) };
         let posB = { x: getRandomCoord(MAP_WIDTH), y: getRandomCoord(MAP_HEIGHT) };
         
         // Garante que B não caia no mesmo lugar que A
         while (posA.x === posB.x && posA.y === posB.y) {
             posB = { x: getRandomCoord(MAP_WIDTH), y: getRandomCoord(MAP_HEIGHT) };
         }

         foods.push({
             x: posA.x,
             y: posA.y,
             type: 'blackhole',
             pairId: pairId,
             id: 'A'
         });
         foods.push({
             x: posB.x,
             y: posB.y,
             type: 'blackhole',
             pairId: pairId,
             id: 'B'
         });
     } else {
         // Spawna fruta única normal
         foods.push({ 
             x: getRandomCoord(MAP_WIDTH), 
             y: getRandomCoord(MAP_HEIGHT),
             type: type
         });
     }
  }
};

// --- LÓGICA DE SPAWN INTELIGENTE (Segurança) ---
const getSafeSpawnLocation = () => {
    const playerList = Object.values(players);
    // Se não tem ninguém, aleatório puro
    if (playerList.length === 0) {
        return { x: getRandomCoord(MAP_WIDTH), y: getRandomCoord(MAP_HEIGHT) };
    }

    // Gera 5 candidatos aleatórios
    let candidates = [];
    for(let i=0; i<5; i++) {
        candidates.push({ x: getRandomCoord(MAP_WIDTH), y: getRandomCoord(MAP_HEIGHT) });
    }

    let bestCandidate = candidates[0];
    let maxMinDist = -1;

    // Para cada candidato, calcula quão longe está do inimigo mais próximo (Maximin)
    candidates.forEach(pos => {
        let minDist = Infinity;
        playerList.forEach(p => {
             const dx = p.x - pos.x;
             const dy = p.y - pos.y;
             const dist = Math.sqrt(dx*dx + dy*dy);
             if (dist < minDist) minDist = dist;
        });

        // Queremos o candidato cuja distância mínima seja a MAIOR possível (mais isolado)
        if (minDist > maxMinDist) {
            maxMinDist = minDist;
            bestCandidate = pos;
        }
    });

    return bestCandidate;
};

// --- SOCKET.IO: Eventos de Conexão ---
io.on('connection', (socket) => {
  console.log('Usuário conectado (Lobby):', socket.id);

  // Jogador tenta entrar na partida
  socket.on('joinGame', (data) => {
    // Suporta formato antigo (string) e novo (objeto {name, color})
    const nickname = typeof data === 'string' ? data : data.name;
    const requestedColor = typeof data === 'object' ? data.color : null;

    if (Object.keys(players).length >= 4) { // Limite hardcoded de 4 players
        socket.emit('joinError', 'Servidor cheio (Max 4)');
        return;
    }

    // Validação de Cores (Evita cores repetidas)
    const defaultColors = ['#00ff88', '#bc13fe', '#ff0055', '#00ccff'];
    let myColor = requestedColor;

    const usedColors = Object.values(players).map(p => p.color);
    // Se cor inválida, não autorizada ou já usada -> Atribui uma livre
    if (!myColor || !defaultColors.includes(myColor) || usedColors.includes(myColor)) {
         const available = defaultColors.filter(c => !usedColors.includes(c));
         myColor = available.length > 0 ? available[0] : defaultColors[Math.floor(Math.random()*defaultColors.length)];
    }

    const spawnPos = getSafeSpawnLocation();
    const startX = spawnPos.x;
    const startY = spawnPos.y;

    // Corpo inicial (3 segmentos)
    let body = [];
    for(let i=0; i<3; i++) {
        body.push({ x: startX, y: startY + (i*TILE_SIZE) }); 
    }

    // Cria Objeto do Jogador
    players[socket.id] = {
        id: socket.id,
        name: nickname.substring(0, 10) || "Snake",
        x: startX,
        y: startY,
        dx: 0, 
        dy: 0, 
        lastDx: 0, 
        lastDy: 0, 
        body: body,
        color: myColor,
        score: 0,
        lastSeq: 0, // Sequência de input processada
        inputQueue: [],
        
        // --- NOVAS PROPRIEDADES DE ESTADO ---
        canDash: false,
        dashUntil: 0, 
        dashCooldown: 0,
        effect: null, // 'rainbow', 'sluggish', etc
        effectUntil: 0,
        moveTickCounter: 0, // Para efeitos de lentidão
        
        // Frutas Complexas
        growthPending: 0, // Acúmulo de crescimento (para Blueberry)
        isInvisible: false, // Fantasma
        invisibleUntil: 0,
        hasFireTrail: false, // Rastro de Fogo
        fireTrailUntil: 0,
        isImmune: false, // Imunidade
        immuneUntil: 0, 
        isPredator: false, // Predador
        predatorUntil: 0,
        predatorTick: 0
    };

    // Confirma entrada para o cliente
    socket.emit('gameJoined', { id: socket.id, width: MAP_WIDTH, height: MAP_HEIGHT, tileSize: TILE_SIZE });
  });

  // Recebe Input de Movimento
  socket.on('input', (data) => {
    const p = players[socket.id];
    if (!p) return; 

    // Limita fila de inputs para evitar backlog gigante
    if (p.inputQueue.length < 3) {
        p.inputQueue.push(data);
    }
    p.lastSeq = data.seq; 
  });

  // Recebe comando de Dash (Space)
  socket.on('dash', () => {
    const p = players[socket.id];
    if (!p) return;
    const now = Date.now();
    
    // Checa se está congelado
    if (now < freezeEndTime && p.id !== freezeExceptionId) return;

    if (!p.canDash) return;
    if (now < p.dashCooldown) return;
    if (now > p.dashUntil) {
        p.canDash = false; // Acabou o tempo do efeito
        return;
    }
    if (p.dx === 0 && p.dy === 0) return; // Não dá dash parado

    // LÓGICA DO DASH GHOST: Teleporta X blocos pra frente e deixa rastro
    const DASH_DISTANCE = 4;
    
    // Calcula nova posição da cabeça
    let newHeadX = p.x + (p.dx * DASH_DISTANCE);
    let newHeadY = p.y + (p.dy * DASH_DISTANCE);
    
    // Preenche o vazio com segmentos "Ghost" (fantasmas)
    // Isso cria o rastro visual e mantém a conexão lógica
    for(let i=0; i<3; i++) {
        p.x += p.dx;
        p.y += p.dy;
        
        // Verificação simples de parede durante o dash (para não sair do mapa)
        if (p.x < 0 || p.x >= MAP_WIDTH || p.y < 0 || p.y >= MAP_HEIGHT) {
             break;
        }

        // Marca como GHOST para o cliente renderizar translúcido
        p.body.unshift({x: p.x, y: p.y, isGhost: true});
    }

    // Remove do rabo para manter o tamanho (ou simular movimento rápido)
    // Removemos 3 peças pois adicionamos 3 fantasmas + a nova cabeça entrará logo em seguida
    for(let i=0; i<3; i++) {
         p.body.pop();
    }

    p.dashCooldown = now + 1000; // Cooldown de 1 segundo entre dashes
    socket.emit('playSound', 'dash');
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
  });
});

// --- GAME LOOP PRINCIPAL ---
setInterval(() => {
  spawnFood();

  const deadPlayers = [];
  const now = Date.now();

  // 0. Limpeza de Riscos Expirados
  fireHazards = fireHazards.filter(h => now < h.expiresAt);
  smokeClouds = smokeClouds.filter(s => now < s.expiresAt);

  // Loop de Movimento de cada Jogador
  for (let id in players) {
    let p = players[id];

    // 1. CHECAGEM DE CONGELAMENTO
    // Se o tempo está parado e eu não sou a exceção -> Pula movimento
    if (now < freezeEndTime && p.id !== freezeExceptionId) {
        continue; 
    }
    
    // Checagem de Expiração de Efeitos
    if (p.effect && now > p.effectUntil) p.effect = null;
    if (p.canDash && now > p.dashUntil) p.canDash = false;
    if (p.isInvisible && now > p.invisibleUntil) p.isInvisible = false;
    if (p.hasFireTrail && now > p.fireTrailUntil) p.hasFireTrail = false;
    if (p.isImmune && now > p.immuneUntil) p.isImmune = false;
    if (p.isPredator && now > p.predatorUntil) p.isPredator = false;

    // --- LÓGICA DE PASSOS DE MOVIMENTO ---
    // Permite mudar velocidade (mais rápido = mais passos por tick, lento = pular ticks)
    let steps = 1;
    if (p.effect === 'sluggish') {
        p.moveTickCounter++;
        if (p.moveTickCounter % 2 !== 0) steps = 0; // Move a cada 2 ticks (50% speed)
    }
    else if (p.effect === 'rainbow') { // Rainbow dá velocidade? No código original sim (steps=2)
        steps = 2;
    }
    else if (p.isPredator) {
        // 1.5x Velocidade: 3 passos a cada 2 ticks (1, 2, 1, 2...)
        p.predatorTick++;
        steps = (p.predatorTick % 2 === 0) ? 2 : 1;
    }

    for (let step = 0; step < steps; step++) {
        
        // Processa Input direcionais
        if (step === 0 && p.inputQueue.length > 0) {
            const cmd = p.inputQueue.shift(); 
            let valid = true;
            
            // Validação Anti-Suicídio (Não pode virar 180 graus)
            if (cmd.dir === 'UP' && p.lastDy === TILE_SIZE) valid = false;
            if (cmd.dir === 'DOWN' && p.lastDy === -TILE_SIZE) valid = false;
            if (cmd.dir === 'LEFT' && p.lastDx === TILE_SIZE) valid = false;
            if (cmd.dir === 'RIGHT' && p.lastDx === -TILE_SIZE) valid = false;
            
            if (valid) {
                 if (cmd.dir === 'UP') { p.dx = 0; p.dy = -TILE_SIZE; }
                 if (cmd.dir === 'DOWN') { p.dx = 0; p.dy = TILE_SIZE; }
                 if (cmd.dir === 'LEFT') { p.dx = -TILE_SIZE; p.dy = 0; }
                 if (cmd.dir === 'RIGHT') { p.dx = TILE_SIZE; p.dy = 0; }
            }
        }
        
        // Se estiver parado, não move
        if (p.dx !== 0 || p.dy !== 0) {
            p.x += p.dx;
            p.y += p.dy;
        } else {
            break; 
        }
        
        p.lastDx = p.dx;
        p.lastDy = p.dy;

        // COLISÃO COM PAREDES DO MAPA
        if (p.x < 0 || p.x >= MAP_WIDTH || p.y < 0 || p.y >= MAP_HEIGHT) {
            // Imunidade protege de morrer na parede
            if (p.isImmune) {
                // Desfaz movimento e para
                p.x -= p.dx; 
                p.y -= p.dy;
                p.dx = 0; p.dy = 0;
            } else {
                deadPlayers.push(id);
                io.to(id).emit('playSound', 'die_wall');
                
                // Drop de Morte na Parede: "Cuspir" massa
                const dropVal = Math.floor(p.body.length * 0.5);
                if (dropVal > 0) {
                     // Spawna 1 bloco atrás (para não nascer fora do mapa)
                     foods.push({
                        x: p.x - p.dx,
                        y: p.y - p.dy,
                        type: 'death_drop',
                        value: dropVal
                     });
                }
            }
        }

        p.body.unshift({x: p.x, y: p.y}); // Adiciona nova cabeça

        // GERAÇÃO DE RASTRO DE LAVA
        if (p.hasFireTrail && !deadPlayers.includes(id)) {
            // Gera fogo atrás do pescoço para não matar a própria cabeça instantaneamente
            let centerX = p.body[1]?.x;
            let centerY = p.body[1]?.y;
            
            if (centerX === undefined) { centerX = p.x; centerY = p.y; }

            // Alinha
             centerX = Math.floor(centerX / TILE_SIZE) * TILE_SIZE;
             centerY = Math.floor(centerY / TILE_SIZE) * TILE_SIZE;

            const centerFire = { x: centerX, y: centerY };
            
            // Gera fogo nas laterais também (Barreira de fogo)
            let perpX = 0;
            let perpY = 0;
            
            if (p.dx !== 0) { // Movendo horizontal
                 perpY = TILE_SIZE;
            } else { // Movendo vertical
                 perpX = TILE_SIZE;
            }
            
            const leftFire = { x: centerFire.x - perpX, y: centerFire.y - perpY };
            const rightFire = { x: centerFire.x + perpX, y: centerFire.y + perpY };
            
            const expiry = now + 4000; // Fogo dura 4 segundos
            // Adiciona OwnerID para pontuar kills
            fireHazards.push({ ...centerFire, expiresAt: expiry, ownerId: id });
            fireHazards.push({ ...leftFire, expiresAt: expiry, ownerId: id });
            fireHazards.push({ ...rightFire, expiresAt: expiry, ownerId: id });
        }

        // CHECAGEM DE FRUTAS (COMER)
        let ate = false;
        for(let i=0; i<foods.length; i++) {
            if (p.x === foods[i].x && p.y === foods[i].y) {
                const eatenFood = foods[i];
                foods.splice(i, 1);
                ate = true;
                
                // Aplica efeitos baseados no tipo
                if (eatenFood.type === 'normal') {
                    if (!p.isPredator) p.score += 1;
                } 
                // Fruta de Morte (Resto Mortal)
                else if (eatenFood.type === 'death_drop') {
                   p.growthPending += eatenFood.value; // Cresce muito
                   if (!p.isPredator) p.score += eatenFood.value;
                }
                // Blueberry (Crescimento)
                else if (eatenFood.type === 'blueberry') {
                    p.growthPending += 5;
                    if (!p.isPredator) p.score += 5;
                }
                // Ghost (Fantasma)
                else if (eatenFood.type === 'ghost') {
                    p.isInvisible = true;
                    p.invisibleUntil = Date.now() + 8000; 
                    if (!p.isPredator) p.score += 3;
                }
                // Reverse (Inversão Total de Corpo)
                else if (eatenFood.type === 'reverse') {
                    if (!p.isPredator) p.score += 4;
                    
                    // 1. Inverte Array do Corpo
                    p.body.reverse();
                    
                    // 2. Head vira tail, tail vira head
                    const newHead = p.body[0];
                    p.x = newHead.x;
                    p.y = newHead.y;

                    // 3. Calcula Nova Direção Baseada na Geometria
                    if (p.body.length > 1) {
                        const neck = p.body[1];
                        // Direção é de Pescoço -> Cabeça
                        p.dx = newHead.x - neck.x;
                        p.dy = newHead.y - neck.y;
                    } else {
                        // Se for tamanho 1, só inverte direção
                        p.dx *= -1;
                        p.dy *= -1;
                    }
                    
                    p.lastDx = p.dx; 
                    p.lastDy = p.dy;
                    p.inputQueue = []; // Limpa inputs para evitar confusão imediata
                }
                // Black Hole (Portal)
                else if (eatenFood.type === 'blackhole') {
                    if (!p.isPredator) p.score += 5;
                    // Procura o par correspondente
                    const pairIndex = foods.findIndex(f => f.type === 'blackhole' && f.pairId === eatenFood.pairId);
                    
                    if (pairIndex !== -1) {
                        const exitPortal = foods[pairIndex];
                        // Teleporta para a saída
                        p.x = exitPortal.x;
                        p.y = exitPortal.y;
                        
                        // Atualiza visualmente o body[0]
                        p.body[0].x = p.x;
                        p.body[0].y = p.y;
                        
                        // Remove o par também (portal fecha)
                        foods.splice(pairIndex, 1);
                    }
                }
                // Rainbow (Efeito visual + pontos)
                else if (eatenFood.type === 'rainbow') {
                    p.effect = 'rainbow';
                    p.effectUntil = Date.now() + 5000; 
                    if (!p.isPredator) p.score += 2;
                }
                // Sluggish (Lentidão)
                else if (eatenFood.type === 'sluggish') {
                    p.effect = 'sluggish';
                    p.effectUntil = Date.now() + 5000; 
                    if (!p.isPredator) p.score += 2;
                }
                // Dash (Habilita dash)
                else if (eatenFood.type === 'dash') {
                    p.canDash = true;
                    p.dashUntil = Date.now() + 10000; 
                    if (!p.isPredator) p.score += 3;
                }
                // Cyan (Congelar tempo para outros)
                else if (eatenFood.type === 'cyan') {
                    if (!p.isPredator) p.score += 5;
                    freezeEndTime = Date.now() + 3000;
                    freezeExceptionId = p.id;
                }
                // Orange (Habilita rastro de fogo)
                else if (eatenFood.type === 'orange') {
                    p.score += 5;
                    p.hasFireTrail = true;
                    p.fireTrailUntil = Date.now() + 5000;
                }
                // Smoke (Solta fumaça no mapa)
                else if (eatenFood.type === 'smoke') {
                    p.score += 3;
                    smokeClouds.push({
                        x: p.x,
                        y: p.y,
                        r: 50 * TILE_SIZE, // Raio grande
                        ownerId: p.id,
                        expiresAt: Date.now() + 10000
                    });
                }
                // Immunity (Imunidade a colisões)
                else if (eatenFood.type === 'immunity') {
                    p.score += 5;
                    p.isImmune = true;
                    p.immuneUntil = Date.now() + 10000;
                }
                // Predator (Modo Caçador)
                else if (eatenFood.type === 'predator') {
                    p.score += 5; 
                    p.isPredator = true;
                    p.predatorUntil = Date.now() + 25000;
                }

                // Dispara Som de Comer
                let soundType = 'eat_normal';
                if (eatenFood.type === 'normal') soundType = 'eat_normal';
                else if (['blackhole', 'predator'].includes(eatenFood.type)) soundType = 'eat_bad';
                else soundType = 'eat_buff'; 

                io.to(id).emit('playSound', soundType);
                break;
            }
        }
        
        // LÓGICA DE CRESCIMENTO
        // Se comeu -> Não remove rabo (Cresce 1)
        // Se NÃO comeu:
        //    Se tem growthPending > 0 -> decrementa e Não remove rabo (Cresce logicamente)
        //    Senão -> Remove rabo (Move normal mantendo tamanho)
        
        let grew = false;
        if(ate) {
            grew = true;
        } else if (p.growthPending > 0) {
            p.growthPending--;
            grew = true;
        }

        if(!grew) {
            p.body.pop(); 
        }

        // Helper para Spawbar Drop de Morte
        const spawnDeathDrop = (x, y, bodyLength) => {
            const val = Math.floor(bodyLength * 0.5);
            if (val <= 0) return;
            
            foods.push({
                x: x,
                y: y,
                type: 'death_drop',
                value: val
            });
        };

        // COLISÃO CONTIGO MESMO
        for(let i=1; i<p.body.length; i++) {
            if (p.x === p.body[i].x && p.y === p.body[i].y) {
                deadPlayers.push(id);
                io.to(id).emit('playSound', 'die_self');
                spawnDeathDrop(p.x, p.y, p.body.length);
                break;
            }
        }

        if (deadPlayers.includes(id)) break;
    }
  }

  // --- 2. COLISÃO ENTRE JOGADORES (PvP) ---
  for (let id in players) {
      if (deadPlayers.includes(id)) continue;
      let pHead = players[id]; 
      
      for (let otherId in players) {
          if (id === otherId) continue; 
          let other = players[otherId];
          if (deadPlayers.includes(otherId)) continue; 

          // Colisão Cabeça-com-Cabeça
          if (pHead.x === other.x && pHead.y === other.y) {
               // Imunidade evita morte
               if (pHead.isImmune || other.isImmune) continue;

               // Ambos morrem
               deadPlayers.push(id);
               deadPlayers.push(otherId);
               io.to(id).emit('playSound', 'die_enemy');
               io.to(otherId).emit('playSound', 'die_enemy');
               continue;
          }

          // Colisão Cabeça-com-Corpo (Atropelar alguém)
          let hitBody = false;
          for (let i = 1; i < other.body.length; i++) {
              // IGNORA segmentos 'ghost' (do dash)
              if (other.body[i].isGhost) continue;

              if (pHead.x === other.body[i].x && pHead.y === other.body[i].y) {
                  hitBody = true;
                  break;
              }
          }

          if (hitBody) {
              if (pHead.isImmune) {
                  hitBody = false; // Ignora se imune
              } else {
                  deadPlayers.push(id);
                  io.to(id).emit('playSound', 'die_enemy');
                  
                  // Lógica de Roubo de Pontos
                  const victimScore = players[id].score;
                  const victimLength = players[id].body.length;
                  
                  players[id].score = Math.max(0, players[id].score - 5);
                  
                  // Recompensa para quem matou
                  players[otherId].score += 10;
                  io.to(otherId).emit('playSound', 'kill');
                  
                  // Ganha 50% dos pontos e do tamanho da vítima
                  players[otherId].score += Math.floor(victimScore * 0.5);
                  players[otherId].growthPending += Math.floor(victimLength * 0.75);
                  
                  // Se era Predador, ganha bônus e buff aleatório
                  if (players[otherId].isPredator) {
                      players[otherId].score += 40; 
                      
                      const buffs = ['ghost', 'orange', 'dash', 'rainbow', 'immunity'];
                      const randBuff = buffs[Math.floor(Math.random()*buffs.length)];
                      
                      if(randBuff === 'ghost') { 
                          players[otherId].isInvisible = true; 
                          players[otherId].invisibleUntil = Date.now() + 5000; 
                      }
                      else if (randBuff === 'orange') {
                          players[otherId].hasFireTrail = true;
                          players[otherId].fireTrailUntil = Date.now() + 5000;
                      }
                      else if (randBuff === 'dash') {
                          players[otherId].canDash = true;
                          players[otherId].dashUntil = Date.now() + 10000;
                      }
                      else if (randBuff === 'immunity') {
                          players[otherId].isImmune = true;
                          players[otherId].immuneUntil = Date.now() + 10000;
                      }
                      else if (randBuff === 'rainbow') { // Visual
                          players[otherId].effect = 'rainbow';
                          players[otherId].effectUntil = Date.now() + 5000;
                      }
                  }
              }
          }
      }
  }

  // --- 3. COLISÃO COM LAVA (Fire Hazards) ---
  for (let id in players) {
      if (deadPlayers.includes(id)) continue;
      let p = players[id];
      if (p.isImmune) continue;

      for (let h of fireHazards) {
          if (p.x === h.x && p.y === h.y) {
               deadPlayers.push(id);
               io.to(id).emit('playSound', 'die_enemy'); // Lava conta como inimigo/perigo
               break; 
          }
      }
  }

  // Processa Jogadores Mortos
  [...new Set(deadPlayers)].forEach(id => {
      if (players[id]) {
        const socket = io.sockets.sockets.get(id);
        if(socket) socket.emit('gameOver', { score: players[id].score });
        delete players[id]; 
      }
  });


  // Prepara pacote de atualização (Compacto) para enviar aos clientes
  const pack = {
    p: [], // players
    f: foods, // frutas
    h: fireHazards, // lava
    s: smokeClouds // fumaça
  };
  
  for (let id in players) {
      let p = players[id];
      pack.p.push({
          i: p.id,
          x: p.x,
          y: p.y,
          b: p.body,
          c: p.color,
          s: p.score,
          n: p.name,
          
          // Flags Visuais para o Cliente
          inv: p.isInvisible,
          eff: p.effect || (p.moveTickCounter > 0 ? 'sluggish' : null), 
          predator: p.isPredator,
          immune: p.isImmune
      });
  }

  io.emit('state', pack);

}, TICK_MS);


// Inicia Servidor
const PORT = process.env.PORT || 3003;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
