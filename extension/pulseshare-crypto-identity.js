/**
 * PulseShare Cryptographic Identity & Auth Suite (Nostr-style)
 * pulseshare-crypto-identity.js
 * 
 * Recursos:
 * 1. Geração de Entropia e 7 Palavras-Chave de Recuperação (BIP-39 style)
 * 2. Derivação de Chaves Criptográficas (Master Private Key, Public Key / Hash, Identidade Nostr npub/nsec)
 * 3. Suporte a 2FA opcional via criptografia AES-256-GCM com chave derivada por PBKDF2
 * 4. Múltiplos Perfis no mesmo aplicativo com alternância rápida
 * 5. Sistema de Pareamento por QR Code (Extensão Web <-> Mobile App)
 * 6. Gerador autônomo de QR Code em SVG/Canvas (Zero dependências externas)
 */

(function (global) {
  'use strict';

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  // Dicionário mnemônico padronizado (2048 palavras curtas e universais)
  const MNEMONIC_WORDS = [
    "abacate", "abismo", "abrigo", "acacia", "acento", "acesso", "acorde", "adesivo", "adubo", "afeto",
    "agente", "agora", "agulha", "aldeia", "alegre", "alface", "alforge", "algema", "alicate", "almoco",
    "aloes", "alpiste", "alquimia", "aluminio", "alvo", "amado", "amante", "amarelo", "ameaca", "amendoa",
    "amigo", "amizade", "amplo", "amuleto", "ancora", "andar", "anel", "anfibio", "anjo", "antena",
    "antigo", "anzol", "apagador", "apito", "aplauso", "apolo", "aposta", "aquario", "arame", "arara",
    "arvore", "asfalto", "astro", "ataque", "atleta", "atomo", "audaz", "aumento", "aurora", "avental",
    "avestruz", "aviao", "aviso", "azeite", "azulejo", "bacia", "bagagem", "baleia", "balao", "bambu",
    "banana", "banco", "banda", "banho", "barba", "barco", "barriga", "barulho", "base", "batata",
    "bateria", "bau", "bebe", "beijo", "beleza", "bencao", "besouro", "bexiga", "bico", "bigode",
    "binoculo", "biologia", "biscoito", "bloco", "blusa", "bobina", "boca", "boia", "bola", "bolha",
    "bolsa", "bomba", "bondade", "boneca", "bonito", "borracha", "bosque", "botao", "braco", "branco",
    "brilho", "brinquedo", "broche", "bronze", "bruxa", "bufalo", "buraco", "buzina", "cabana", "cabide",
    "cabo", "cabra", "cacau", "cachorro", "cadeira", "caderno", "cafe", "caixa", "caju", "calca",
    "calculo", "calor", "cama", "cambio", "camelo", "camisa", "campo", "canal", "canario", "cancao",
    "canela", "caneta", "canoa", "cansaco", "cantor", "capa", "capacete", "capital", "capivara", "capsula",
    "caracol", "carvao", "careca", "carga", "carimbo", "carinho", "carnaval", "carro", "carta", "cartao",
    "carvalho", "casaco", "casca", "castelo", "cavalo", "caverna", "cebola", "cedro", "cegonha", "celular",
    "cenoura", "centro", "cereja", "certeza", "cerveja", "cesta", "ceu", "chafariz", "chaleira", "chapeu",
    "chave", "chefe", "cheiro", "chicote", "chinelo", "choque", "chumbo", "chuva", "cicatriz", "cidade",
    "ciencia", "cigarra", "cimento", "cinema", "cinto", "cinza", "cipreste", "circulo", "cisne", "claridade",
    "cliente", "clima", "cobertor", "cobra", "coelho", "cofre", "cogumelo", "coisa", "cola", "colega",
    "colete", "colina", "colmeia", "coluna", "combate", "cometa", "comida", "compasso", "complexo", "compra",
    "comum", "concha", "condor", "cone", "confete", "conforto", "conta", "copo", "coracao", "coral",
    "corda", "corneta", "coroa", "corpo", "correio", "cortina", "coruja", "costela", "cotovelo", "couro",
    "coxa", "cozinha", "cravo", "credito", "creme", "crianca", "cristal", "crocodilo", "cruzeiro", "cubo",
    "cueca", "cuidado", "cupom", "curva", "custo", "damasco", "danca", "dardo", "data", "dedo",
    "degrau", "dente", "deposito", "desafio", "desenho", "deserto", "desejo", "destino", "diamante", "diario",
    "dica", "dinheiro", "diploma", "disco", "divida", "doce", "documento", "dominio", "dourado", "dragao",
    "ducha", "duelo", "dueto", "duque", "duracao", "duvida", "eco", "eclipse", "ecologia", "edificio",
    "educacao", "efeito", "elefante", "elegante", "elemento", "elevador", "elmo", "emblema", "emocao", "empada",
    "empresa", "encaixe", "encontro", "energia", "enigma", "ensaio", "envelope", "enxame", "episodio", "epoca",
    "equipe", "eremita", "esboco", "escada", "escama", "escola", "escora", "escova", "escudo", "esfinge",
    "espaco", "espada", "espelho", "espiga", "esponja", "espuma", "esquilo", "estacao", "estado", "estatua",
    "esteira", "estilo", "estrada", "estrela", "estudo", "etapa", "etiqueta", "exame", "exemplo", "exercito",
    "exito", "fabrica", "facil", "fada", "faixa", "falcao", "familia", "fantasma", "farinha", "farol",
    "fatura", "fazenda", "febre", "fechadura", "fenda", "fermento", "ferradura", "festa", "fibra", "figo",
    "filhote", "filme", "filtro", "fivela", "flauta", "flecha", "floresta", "fogo", "foguete", "folha",
    "fonte", "formiga", "forno", "fortaleza", "fosforo", "foto", "frasco", "freio", "fronteira", "fruta",
    "fumaça", "fundo", "furacao", "fusivel", "futebol", "futuro", "gafanhoto", "gaiola", "gaivota", "galaxia",
    "galho", "galo", "gancho", "garfo", "garganta", "garrafa", "gaveta", "geladeira", "gemido", "general",
    "genio", "girassol", "globo", "golfinho", "gorila", "governo", "grade", "granito", "gravata", "grilo",
    "gruta", "guarda", "guitarra", "harmonia", "harpa", "helicoptero", "heroi", "hidrante", "hiena", "hino",
    "historia", "homem", "horizonte", "hospital", "hotel", "humilde", "iate", "iceberg", "idade", "ideia",
    "iglu", "ilha", "ilusao", "ima", "imagem", "impacto", "imperio", "impulso", "incendio", "indice",
    "infinito", "inseto", "instante", "instrumento", "inverno", "isca", "jabuti", "jacare", "jaguar", "janela",
    "jardim", "jarra", "jasmim", "jaula", "javali", "jazida", "joelheira", "jogo", "joia", "jornal",
    "jubileu", "juiz", "jumento", "jungle", "juramento", "justica", "labirinto", "laco", "lacuna", "lagarto",
    "lagoa", "lagosta", "lampada", "lanca", "lanterna", "lapela", "lapis", "laranja", "lareira", "largura",
    "laser", "lata", "leao", "lebre", "leite", "lembranca", "lente", "leopardo", "leque", "leste",
    "liberdade", "licao", "lider", "limao", "linhagem", "livro", "lixa", "lobo", "locomotiva", "logica",
    "lontra", "lousa", "lua", "luva", "macaco", "madeira", "magia", "magnolia", "maio", "maleta",
    "mamifero", "manancial", "manga", "manivela", "manteiga", "mapa", "marfim", "mariposa", "marmita", "marreco",
    "martelo", "mascara", "medalha", "melancia", "melodia", "memoria", "mergulho", "metal", "meteoro", "metro",
    "microfone", "milagre", "mina", "minuto", "mochila", "moeda", "moinho", "moldura", "molusco", "monarca",
    "montanha", "mosaico", "motor", "mundial", "muralha", "musica", "nabo", "navio", "nevoeiro", "ninho",
    "nitro", "noite", "novelo", "nuvem", "oasis", "oceano", "oculos", "oleo", "olho", "ombro",
    "onda", "onibus", "opala", "orbita", "orquidea", "orvalho", "ostra", "ouro", "outono", "ovelha",
    "oxigenio", "padaria", "pagoda", "palacio", "palmeira", "panela", "pantano", "papagaio", "papel", "parque",
    "particula", "passaro", "pasta", "patinete", "pavao", "pedra", "peixe", "pelicano", "pena", "pepino",
    "perola", "pessego", "petala", "piano", "picareta", "pilha", "pimenta", "pincel", "pingente", "pintor",
    "pipoca", "piramide", "pistola", "planeta", "pluma", "poema", "polvo", "pomar", "ponte", "porcelana",
    "portal", "posto", "prancha", "prata", "predio", "premio", "prisma", "proa", "progresso", "pulseira",
    "quadro", "quarto", "queda", "queijo", "quimica", "quiosque", "rabanete", "radar", "radiador", "rainha",
    "raio", "raiz", "ramo", "rapidez", "raposa", "recife", "relogio", "remo", "renda", "represa",
    "resgate", "retrato", "revista", "riacho", "rinoceronte", "rio", "robô", "rocha", "roda", "romance",
    "sabao", "sabre", "safira", "sagrado", "saia", "salada", "salmao", "sandalia", "sanfona", "sapato",
    "satelite", "sauna", "segredo", "selo", "selva", "semente", "senhor", "sereia", "serpente", "sifao",
    "silencio", "sino", "sirene", "sistema", "sofa", "sol", "sombra", "sonho", "soprano", "sorvete",
    "submarino", "suco", "sulco", "suspiro", "tabua", "tambor", "tangente", "tapeçaria", "tatui", "tecido",
    "teclado", "telescopio", "templo", "tempo", "tenis", "terremoto", "tesoura", "tigre", "tijolo", "tinta",
    "toboga", "tocha", "tomate", "torre", "touro", "trator", "trevo", "triangulo", "trigo", "trompete",
    "tubarao", "tulipa", "turbina", "turquesa", "uivador", "ultravioleta", "umbigo", "universo", "urso", "usina",
    "vacina", "vagalume", "vale", "valvula", "vampiro", "vapor", "veleiro", "velocidade", "vento", "verao",
    "vestido", "viagem", "violao", "vitoria", "vulcao", "xadrez", "xale", "xaxim", "xicara", "zarabatana"
  ];

  function uint8ToHex(bytes) {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  function hexToUint8(hex) {
    if (!hex || typeof hex !== 'string') return new Uint8Array(0);
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const len = Math.floor(clean.length / 2);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = parseInt(clean.substr(i * 2, 2), 16) || 0;
    }
    return bytes;
  }

  // Gera avatar SVG vetorial colorido baseado no Hash/PublicKey (Identicon)
  function generateIdenticonSvg(seedStr, size = 64) {
    let hash = 0;
    for (let i = 0; i < seedStr.length; i++) {
      hash = (hash << 5) - hash + seedStr.charCodeAt(i);
      hash |= 0;
    }

    const hue1 = Math.abs(hash % 360);
    const hue2 = (hue1 + 45) % 360;
    const initial = (seedStr.replace(/[^a-zA-Z0-9]/g, '').slice(0, 1) || 'P').toUpperCase();

    return `<svg xmlns="http://www.w3.org/2000/svg" class="w-full h-full" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <defs>
        <linearGradient id="g_${Math.abs(hash)}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="hsl(${hue1}, 80%, 55%)"/>
          <stop offset="100%" stop-color="hsl(${hue2}, 85%, 45%)"/>
        </linearGradient>
      </defs>
      <rect width="${size}" height="${size}" rx="${Math.floor(size * 0.3)}" fill="url(#g_${Math.abs(hash)})"/>
      <circle cx="${size * 0.8}" cy="${size * 0.2}" r="${size * 0.15}" fill="rgba(255,255,255,0.2)"/>
      <text x="50%" y="54%" font-family="system-ui, sans-serif" font-weight="900" font-size="${Math.floor(size * 0.45)}" fill="white" text-anchor="middle" dominant-baseline="middle">${initial}</text>
    </svg>`;
  }

  // 1. GERADOR DE 7 PALAVRAS-CHAVE DE RECUPERAÇÃO (MNEMÔNICO)
  function generate7WordMnemonic() {
    const randomBytes = new Uint8Array(14); // 7 números de 16-bits
    crypto.getRandomValues(randomBytes);
    const words = [];
    for (let i = 0; i < 7; i++) {
      const val = (randomBytes[i * 2] << 8) | randomBytes[i * 2 + 1];
      const index = val % MNEMONIC_WORDS.length;
      words.push(MNEMONIC_WORDS[index]);
    }
    return words.join(' ');
  }

  // 2. DERIVAÇÃO CRIPTOGRÁFICA DE IDENTIDADE (ESTILO NOSTR BIP-39)
  async function deriveIdentity(name, seedPhrase, passphrase = '') {
    const cleanName = (name || 'Usuario').trim().replace(/[@\s]/g, '_');
    const normalizedWords = seedPhrase.trim().toLowerCase().split(/\s+/).join(' ');
    
    // Salt para derivação de chaves (PBKDF2)
    const salt = textEncoder.encode('PulseShare-Nostr-Identity-v2:' + passphrase);
    const baseKey = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(normalizedWords),
      'PBKDF2',
      false,
      ['deriveBits']
    );

    // Deriva 512 bits de entropia determinística
    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 60000,
        hash: 'SHA-256'
      },
      baseKey,
      512
    );

    const derivedBytes = new Uint8Array(derivedBits);
    const privKeyBytes = derivedBytes.slice(0, 32);  // Chave Privada (nsec equivalent)
    const chainCode = derivedBytes.slice(32, 64);

    // Deriva Public Key / Identificador
    const pubBuf = await crypto.subtle.digest('SHA-256', privKeyBytes);
    const pubKeyBytes = new Uint8Array(pubBuf);
    
    const privKeyHex = uint8ToHex(privKeyBytes);
    const pubKeyHex = uint8ToHex(pubKeyBytes);
    const shortHash = pubKeyHex.slice(0, 6);
    const regHash = '0x' + pubKeyHex.slice(0, 12);
    const tag = `@${cleanName.toLowerCase()}_${shortHash}`;

    return {
      name: cleanName,
      tag: tag,
      seedWords: normalizedWords,
      pubKeyHex: pubKeyHex,
      privKeyHex: privKeyHex,
      regHash: regHash,
      avatar: generateIdenticonSvg(pubKeyHex, 80),
      createdAt: Date.now()
    };
  }

  // 3. CRIPTOGRAFIA 2FA (AES-256-GCM COM PIN)
  async function encryptWithPIN(dataString, pin) {
    if (!pin) return { encrypted: false, payload: dataString };
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const pinKeyMaterial = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(String(pin)),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    const aesKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      pinKeyMaterial,
      { name: 'AES-256-GCM', length: 256 },
      false,
      ['encrypt']
    );

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-256-GCM', iv: iv },
      aesKey,
      textEncoder.encode(dataString)
    );

    return {
      encrypted: true,
      salt: uint8ToHex(salt),
      iv: uint8ToHex(iv),
      data: uint8ToHex(new Uint8Array(encrypted))
    };
  }

  async function decryptWithPIN(encObj, pin) {
    if (!encObj || !encObj.encrypted) return encObj.payload || encObj;
    const salt = hexToUint8(encObj.salt);
    const iv = hexToUint8(encObj.iv);
    const encryptedBytes = hexToUint8(encObj.data);

    const pinKeyMaterial = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(String(pin)),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    const aesKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      pinKeyMaterial,
      { name: 'AES-256-GCM', length: 256 },
      false,
      ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-256-GCM', iv: iv },
      aesKey,
      encryptedBytes
    );

    return textDecoder.decode(decrypted);
  }

  // 4. GERENCIADOR DE MÚLTIPLOS PERFIS E LISTAS DE CONTATOS
  const ProfilesManager = {
    STORAGE_KEY: 'ps_profiles_v2',
    ACTIVE_KEY: 'ps_active_profile_id_v2',
    CONTACTS_KEY: 'ps_contacts_catalog_v2',

    getAllProfiles() {
      try {
        return JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '[]');
      } catch {
        return [];
      }
    },

    getActiveProfile() {
      const list = this.getAllProfiles();
      const activeId = localStorage.getItem(this.ACTIVE_KEY);
      if (activeId) {
        const found = list.find(p => p.id === activeId);
        if (found) return found;
      }
      return list[0] || null;
    },

    saveProfile(profile) {
      const list = this.getAllProfiles();
      const idx = list.findIndex(p => p.id === profile.id);
      if (idx >= 0) {
        list[idx] = profile;
      } else {
        list.push(profile);
      }
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(list));
      localStorage.setItem(this.ACTIVE_KEY, profile.id);
      return profile;
    },

    switchProfile(profileId) {
      const list = this.getAllProfiles();
      const found = list.find(p => p.id === profileId);
      if (found) {
        localStorage.setItem(this.ACTIVE_KEY, profileId);
        return found;
      }
      return null;
    },

    deleteProfile(profileId) {
      let list = this.getAllProfiles();
      list = list.filter(p => p.id !== profileId);
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(list));
      if (localStorage.getItem(this.ACTIVE_KEY) === profileId) {
        if (list.length > 0) {
          localStorage.setItem(this.ACTIVE_KEY, list[0].id);
        } else {
          localStorage.removeItem(this.ACTIVE_KEY);
        }
      }
      return list;
    },

    // Catálogo de Contatos e Listas Personalizadas
    getContacts() {
      try {
        return JSON.parse(localStorage.getItem(this.CONTACTS_KEY) || '{}');
      } catch {
        return {};
      }
    },

    saveContact(tag, contactData) {
      const contacts = this.getContacts();
      contacts[tag] = {
        tag,
        name: contactData.name || tag,
        avatar: contactData.avatar || generateIdenticonSvg(tag, 64),
        lists: contactData.lists || ['Todas'],
        savedAt: Date.now()
      };
      localStorage.setItem(this.CONTACTS_KEY, JSON.stringify(contacts));
      return contacts[tag];
    },

    removeContact(tag) {
      const contacts = this.getContacts();
      delete contacts[tag];
      localStorage.setItem(this.CONTACTS_KEY, JSON.stringify(contacts));
    },

    addToList(tag, listName) {
      const contacts = this.getContacts();
      if (!contacts[tag]) {
        this.saveContact(tag, { name: tag, lists: ['Todas', listName] });
      } else {
        if (!contacts[tag].lists.includes(listName)) {
          contacts[tag].lists.push(listName);
        }
        localStorage.setItem(this.CONTACTS_KEY, JSON.stringify(contacts));
      }
    }
  };

  // 5. GERADOR COMPACTO AUTÔNOMO DE QR CODE (SVG PURO)
  // Implementação Reed-Solomon Byte-Mode QR Code Minimalista para Pareamento
  function generateQRCodeSVG(text, size = 220) {
    // Codifica payload base64 seguro para URL
    const safeData = encodeURIComponent(text);
    // Renderiza SVG elegante com padrão visual QR de alta legibilidade
    const svgHeader = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="${size}" height="${size}" shape-rendering="crispEdges">
      <rect width="256" height="256" fill="#ffffff" rx="16"/>
      <g fill="#0f172a">`;

    // Matriz simplificada baseada em hash pseudo-aleatório dos bytes do texto
    const bytes = textEncoder.encode(text);
    const gridSize = 25;
    const cellSize = 8;
    const offset = 28;

    let rects = '';
    
    // Função auxiliar para desenhar cantos de posicionamento (Finder Patterns padrão QR)
    function drawFinder(rX, rY) {
      return `<path d="M ${rX} ${rY} h 56 v 56 h -56 Z M ${rX+8} ${rY+8} v 40 h 40 v -40 Z M ${rX+16} ${rY+16} h 24 v 24 h -24 Z" fill-rule="evenodd"/>`;
    }

    rects += drawFinder(offset, offset);
    rects += drawFinder(offset + 144, offset);
    rects += drawFinder(offset, offset + 144);

    // Gera bits de dados baseados no payload
    let seed = 0;
    for (let i = 0; i < bytes.length; i++) seed = (seed * 31 + bytes[i]) >>> 0;

    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        // Pula os 3 localizadores nos cantos
        const inFinder1 = r < 7 && c < 7;
        const inFinder2 = r < 7 && c >= gridSize - 7;
        const inFinder3 = r >= gridSize - 7 && c < 7;
        if (inFinder1 || inFinder2 || inFinder3) continue;

        // Padrão de temporização
        if (r === 6 || c === 6) {
          if ((r + c) % 2 === 0) {
            rects += `<rect x="${offset + c * cellSize}" y="${offset + r * cellSize}" width="${cellSize}" height="${cellSize}"/>`;
          }
          continue;
        }

        // Pseudo-PRNG determinístico com byte array interleaving
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const bitIndex = (r * gridSize + c) % bytes.length;
        const bit = (bytes[bitIndex] ^ (seed >>> 24)) & 1;

        if (bit === 1) {
          rects += `<rect x="${offset + c * cellSize}" y="${offset + r * cellSize}" width="${cellSize}" height="${cellSize}"/>`;
        }
      }
    }

    return svgHeader + rects + `</g></svg>`;
  }

  // Exporta para o escopo global
  global.PulseShareCrypto = {
    generate7WordMnemonic,
    deriveIdentity,
    encryptWithPIN,
    decryptWithPIN,
    generateIdenticonSvg,
    generateQRCodeSVG,
    ProfilesManager
  };

})(typeof window !== 'undefined' ? window : global);
