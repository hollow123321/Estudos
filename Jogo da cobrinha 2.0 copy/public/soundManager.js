class AudioManager {
    constructor() {
        this.sounds = {};
        this.enabled = true;
        this.lastPlayedWithTime = {}; // Para evitar spam: { 'chave': timestamp }
        this.spamThreshold = 100; // Tempo em ms entre sons iguais para evitar repetição excessiva
        
        // Controle de Volume
        this.bgmVolume = 0.2; // Volume da música de fundo (baixo para não atrapalhar)
        this.sfxVolume = 1.0; // Volume dos efeitos sonoros
        this.bgm = null; // Variável para armazenar a música de fundo

        // Ativos de Áudio (Placeholder ou Links Diretos)
        // [IMPORTANTE]: Se quiser usar arquivos locais, baixe os mp3 para a pasta "public/sounds"
        // e atualize os caminhos abaixo. Atualmente usando URLs online para teste imediato.
        this.assets = {
            'bgm': 'https://codeskulptor-demos.commondatastorage.googleapis.com/GalaxyInvaders/theme_01.mp3',
            
            // Sons de Comer
            'eat_normal': 'https://codeskulptor-demos.commondatastorage.googleapis.com/pang/pop.mp3',
            'eat_buff': 'https://codeskulptor-demos.commondatastorage.googleapis.com/GalaxyInvaders/bonus.wav', 
            'eat_bad': 'https://actions.google.com/sounds/v1/alarms/beep_short.ogg',

            // Sons de Morte
            'die_wall': 'https://codeskulptor-demos.commondatastorage.googleapis.com/GalaxyInvaders/explosion_01.mp3', // Morte na parede
            'die_self': 'https://codeskulptor-demos.commondatastorage.googleapis.com/GalaxyInvaders/explosion_02.mp3', // Morte batendo em si mesmo
            'die_enemy': 'https://codeskulptor-demos.commondatastorage.googleapis.com/GalaxyInvaders/player_die.wav', // Morte batendo em inimigo
            
            // Outros Efeitos
            'kill': 'https://actions.google.com/sounds/v1/rewards/sfx_coin_single3.ogg', // Som de matar alguém
            'dash': 'https://actions.google.com/sounds/v1/cartoon/whoosh.ogg', // Som de Dash (velocidade)
            
            // Fallbacks (Sons de segurança caso a chave específica não exista)
            'eat': 'https://codeskulptor-demos.commondatastorage.googleapis.com/pang/pop.mp3',
            'die': 'https://codeskulptor-demos.commondatastorage.googleapis.com/GalaxyInvaders/explosion_01.mp3'
        };
        
        // Nota sobre BGM: Usando um tema espacial genérico como placeholder.
        
        this.init();
    }

    // Inicializa carregando os arquivos de áudio
    init() {
        Object.keys(this.assets).forEach(key => {
            const audio = new Audio(this.assets[key]);
            
            // Configuração específica para a música de fundo
            if (key === 'bgm') {
                this.bgm = audio;
                this.bgm.loop = true; // Repetir infinitamente
                this.bgm.volume = this.bgmVolume;
            } else {
                this.sounds[key] = audio;
            }
        });
    }

    // Tenta iniciar a música (necessário interação do usuário no navegador)
    startMusic() {
        if (this.bgm && this.enabled) {
            this.bgm.play().catch(e => console.log("Autoplay da BGM bloqueado até interação do usuário"));
        }
    }

    // Toca um efeito sonoro específico
    play(key) {
        if (!this.enabled) return; // Se estiver mudo, não faz nada
        
        const now = Date.now();
        const last = this.lastPlayedWithTime[key] || 0;

        // Prevenção de Spam: Impede que o mesmo som toque muitas vezes em milissegundos
        if (now - last < this.spamThreshold) return;

        const sound = this.sounds[key];
        if (sound) {
            const clone = sound.cloneNode(); // Clona para permitir sons sobrepostos (ex: comer rápido)
            clone.volume = this.sfxVolume;
            clone.play().catch(e => console.warn("Falha ao tocar áudio:", e));
            this.lastPlayedWithTime[key] = now;
        } else {
            console.warn("Som não encontrado:", key);
        }
    }

    // Alterna entre Mudo e Som Ligado
    toggleMute() {
        this.enabled = !this.enabled;
        
        if (this.bgm) {
            if (this.enabled) this.bgm.play().catch(e => {});
            else this.bgm.pause();
        }
        
        return !this.enabled; // Retorna TRUE se estiver MUDO
    }
}

// Instância Global acessível pelo jogo
window.AudioManager = new AudioManager();
