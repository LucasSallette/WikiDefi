/**
 * WikiDéfi - Client robuste avec auto-correction Wikipédia et retry silencieux
 */

class WikiDefiError extends Error {
  constructor(code, title, message, hint = '') {
    super(message);
    this.code = code;
    this.title = title;
    this.hint = hint;
  }
}

const MAX_AUTO_RETRIES = 3;

const state = {
  difficulty: 'Facile',
  score: 0,
  streak: 0,
  best: Number(localStorage.getItem('wikidefi_best') || 0),
  soundEnabled: true,
  isLoading: false,
  roundResolved: false,
  currentItems: [],
  usedTitles: new Set(),
};

const dom = {
  score: document.getElementById('score-value'),
  streak: document.getElementById('streak-value'),
  best: document.getElementById('best-value'),
  diffBtns: document.querySelectorAll('.diff-btn'),
  soundToggle: document.getElementById('sound-toggle'),
  newRoundBtn: document.getElementById('new-round-btn'),
  errorBanner: document.getElementById('error-banner'),
  errorCode: document.getElementById('error-code'),
  errorTitle: document.getElementById('error-title'),
  errorMessage: document.getElementById('error-message'),
  errorHint: document.getElementById('error-hint'),
  retryBtn: document.getElementById('retry-btn'),
  loader: document.getElementById('loader'),
  loaderText: document.getElementById('loader-text'),
  cardsGrid: document.getElementById('cards-grid'),
  resultPanel: document.getElementById('result-panel'),
  resultVerdict: document.getElementById('result-verdict'),
  resultDetail: document.getElementById('result-detail'),
  nextBtn: document.getElementById('next-btn'),
};

// Synthétiseur audio 8-bit
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playTone(freq, duration, type = 'square', delay = 0) {
  if (!state.soundEnabled) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime + delay);
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + delay);
    osc.stop(audioCtx.currentTime + delay + duration);
  } catch {
    // Ignore si bloqué avant clic
  }
}

const sfx = {
  click: () => playTone(520, 0.08),
  win: () => {
    playTone(523.25, 0.1, 'square', 0);
    playTone(659.25, 0.1, 'square', 0.1);
    playTone(783.99, 0.22, 'square', 0.2);
  },
  lose: () => {
    playTone(300, 0.15, 'sawtooth', 0);
    playTone(210, 0.28, 'sawtooth', 0.15);
  },
  error: () => {
    playTone(160, 0.2, 'sawtooth', 0);
    playTone(130, 0.25, 'sawtooth', 0.18);
  },
};

function sanitizeDescription(text) {
  if (!text) return 'Élément historique ou culturel issu de Wikipédia.';
  return text
    .replace(/\b(1[0-9]{3}|20[0-2][0-9])\b/g, '[date masquée]')
    .replace(/\b(I|V|X|L|C|D|M)+e\s+siècle\b/gi, 'époque passée')
    .replace(/\b(années\s+[0-9]{2,4})\b/gi, 'période passée')
    .trim();
}

/**
 * Résout l'URL exacte de groq.php dans le même répertoire que la page courante
 */
function getBackendUrl() {
  const path = window.location.pathname;
  const dir = path.endsWith('/') ? path : path.substring(0, path.lastIndexOf('/') + 1);
  return `${window.location.origin}${dir}groq.php`;
}

/**
 * Appelle groq.php pour obtenir un pool de 4 candidats
 */
async function fetchCandidatesFromBackend() {
  if (window.location.protocol === 'file:') {
    throw new WikiDefiError(
      'PHP_LOCAL',
      'Serveur PHP requis',
      'Le fichier index.html a été ouvert directement (file://) sans serveur PHP.',
      'Lancez un serveur PHP local (ex: "php -S localhost:8000" ou WAMP/XAMPP/Laragon).'
    );
  }

  const backendUrl = getBackendUrl();
  let res;
  let rawText;
  try {
    res = await fetch(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        difficulty: state.difficulty,
        excluded: Array.from(state.usedTitles).slice(-30),
      }),
    });
    rawText = await res.text();
  } catch {
    throw new WikiDefiError(
      'NET_ERR',
      'Serveur inaccessible',
      `Impossible de joindre ${backendUrl}.`,
      'Vérifiez que votre serveur web est bien démarré.'
    );
  }

  // Détection si le serveur renvoie le code source PHP brut (PHP non exécuté)
  if (rawText.trim().startsWith('<?php')) {
    throw new WikiDefiError(
      'PHP_INACTIVE',
      'PHP n’est pas exécuté par le serveur',
      'Le serveur a renvoyé le code brut de groq.php au lieu de l’exécuter.',
      'Activez PHP sur votre hébergement (ex: hébergement statique type GitHub Pages/Netlify ne supporte pas PHP).'
    );
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = null;
  }

  if (data?.error === true) {
    throw new WikiDefiError(
      data.code || `HTTP ${res.status}`,
      data.title || 'Erreur Groq AI',
      data.message || 'Une erreur est survenue lors de la génération.',
      data.hint || 'Cliquez sur RÉESSAYER.'
    );
  }

  if (!res.ok || !Array.isArray(data?.items)) {
    const diagnostics = {
      403: ['Accès à groq.php refusé', 'Vérifiez les règles d’accès du domaine et les droits du fichier.'],
      404: ['Fichier groq.php introuvable à cette adresse', 'Vérifiez le dossier public du domaine et extrayez les fichiers du ZIP directement à côté de index.html.'],
      405: ['Les requêtes POST vers groq.php sont refusées', 'Vérifiez que ce domaine utilise un hébergement qui exécute PHP.'],
      500: ['Erreur PHP ou serveur', 'Consultez le journal d’erreurs PHP du domaine.'],
      502: ['Le serveur ne reçoit pas de réponse de PHP', 'Vérifiez PHP-FPM et le journal d’erreurs du domaine.'],
      503: ['Service PHP ou web indisponible', 'Vérifiez l’état des services web du domaine.'],
      504: ['Le serveur a dépassé le délai d’attente', 'Vérifiez les journaux PHP et la connexion sortante vers Groq.'],
    };
    const [title, hint] = diagnostics[res.status] || [
      'Réponse inattendue de groq.php',
      'Ouvrez cette adresse dans le navigateur. Le diagnostic doit afficher le service wikidefi-groq et le statut ok.',
    ];
    throw new WikiDefiError(
      `HTTP ${res.status}`,
      title,
      `Adresse appelée : ${backendUrl}`,
      hint
    );
  }

  return data.items;
}

async function getWikiSummaryByTitle(title) {
  const encoded = encodeURIComponent(title.trim());
  const url = `https://fr.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });

  if (!res.ok) return null;
  const data = await res.json();

  if (data.type === 'disambiguation' || !data.extract) return null;
  return data;
}

async function searchBestWikiArticle(query) {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: '3',
    format: 'json',
    origin: '*',
  });

  const res = await fetch(`https://fr.wikipedia.org/w/api.php?${params.toString()}`);
  if (!res.ok) return null;

  const data = await res.json();
  const hits = data?.query?.search || [];

  for (const hit of hits) {
    const summary = await getWikiSummaryByTitle(hit.title);
    if (summary) return summary;
  }
  return null;
}

async function tryEnrichCandidate(aiItem) {
  try {
    if (!aiItem || !aiItem.wikiTitle) return null;

    let wikiData = await getWikiSummaryByTitle(aiItem.wikiTitle);
    if (!wikiData) {
      const fallbackQuery = aiItem.searchQuery || aiItem.wikiTitle;
      wikiData = await searchBestWikiArticle(fallbackQuery);
    }

    if (!wikiData) return null;

    const extractText = wikiData.extract || '';
    const yearMatches = extractText.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/g);
    let verifiedYear = Number(aiItem.estimatedYear);

    if (yearMatches && yearMatches.length > 0) {
      const numericYears = yearMatches.map(Number);
      numericYears.sort((a, b) => Math.abs(a - verifiedYear) - Math.abs(b - verifiedYear));
      if (!Number.isNaN(verifiedYear) && Math.abs(numericYears[0] - verifiedYear) <= 25) {
        verifiedYear = numericYears[0];
      } else if (Number.isNaN(verifiedYear)) {
        verifiedYear = numericYears[0];
      }
    }

    if (!verifiedYear || Number.isNaN(verifiedYear)) return null;

    return {
      title: wikiData.title,
      description: sanitizeDescription(aiItem.description),
      image: wikiData.thumbnail?.source || wikiData.originalimage?.source || null,
      url:
        wikiData.content_urls?.desktop?.page ||
        `https://fr.wikipedia.org/wiki/${encodeURIComponent(wikiData.title)}`,
      year: verifiedYear,
    };
  } catch {
    return null;
  }
}

function pickDistinctPair(validItems) {
  for (let i = 0; i < validItems.length; i++) {
    for (let j = i + 1; j < validItems.length; j++) {
      if (
        validItems[i].title !== validItems[j].title &&
        validItems[i].year !== validItems[j].year
      ) {
        return [validItems[i], validItems[j]];
      }
    }
  }
  return null;
}

function showError(err) {
  sfx.error();
  dom.loader.classList.add('hidden');
  dom.cardsGrid.classList.add('hidden');
  dom.resultPanel.classList.add('hidden');

  dom.errorCode.textContent = err.code || 'ERREUR';
  dom.errorTitle.textContent = err.title || 'Erreur inattendue';
  dom.errorMessage.textContent = err.message || 'Une erreur est survenue.';

  if (err.hint) {
    dom.errorHint.textContent = `💡 Solution : ${err.hint}`;
    dom.errorHint.classList.remove('hidden');
  } else {
    dom.errorHint.classList.add('hidden');
  }

  dom.errorBanner.classList.remove('hidden');
}

function hideError() {
  dom.errorBanner.classList.add('hidden');
}

function updateScoreboard() {
  dom.score.textContent = state.score;
  dom.streak.textContent = state.streak;
  dom.best.textContent = state.best;
}

async function startNewRound() {
  if (state.isLoading) return;
  state.isLoading = true;
  state.roundResolved = false;

  hideError();
  dom.resultPanel.classList.add('hidden');
  dom.cardsGrid.classList.add('hidden');
  dom.loader.classList.remove('hidden');
  dom.newRoundBtn.disabled = true;

  let lastError = null;

  try {
    for (let attempt = 1; attempt <= MAX_AUTO_RETRIES; attempt++) {
      try {
        dom.loaderText.textContent =
          attempt === 1
            ? `GÉNÉRATION DU DUEL (${state.difficulty.toUpperCase()})...`
            : `AJUSTEMENT DES ARTICLES WIKIPÉDIA (TENTATIVE ${attempt}/${MAX_AUTO_RETRIES})...`;

        const candidates = await fetchCandidatesFromBackend();

        dom.loaderText.textContent = 'VÉRIFICATION SUR WIKIPÉDIA FR...';
        const enrichedResults = await Promise.all(
          candidates.map((cand) => tryEnrichCandidate(cand))
        );

        const validItems = enrichedResults.filter(Boolean);
        const pair = pickDistinctPair(validItems);

        if (!pair) {
          throw new WikiDefiError(
            'WIKI_MATCH',
            'Impossible d’associer deux articles distincts',
            'Les sujets générés n’avaient pas assez d’articles Wikipédia distincts.',
            'Cliquez sur RÉESSAYER pour générer une nouvelle série.'
          );
        }

        state.currentItems = pair;
        state.usedTitles.add(pair[0].title);
        state.usedTitles.add(pair[1].title);

        renderCards();
        dom.loader.classList.add('hidden');
        dom.cardsGrid.classList.remove('hidden');
        return;
      } catch (err) {
        lastError =
          err instanceof WikiDefiError
            ? err
            : new WikiDefiError('UNKNOWN', 'Erreur inattendue', err.message || String(err));

        const fatalCodes = [
          'ENV_404',
          'ENV_READ_ERR',
          'MISSING_KEY',
          'GROQ_401',
          'GROQ_403',
          'PHP_LOCAL',
          'PHP_INACTIVE',
        ];
        if (fatalCodes.includes(lastError.code)) {
          break;
        }
      }
    }

    showError(lastError);
  } finally {
    state.isLoading = false;
    dom.newRoundBtn.disabled = false;
  }
}

function renderCards() {
  state.currentItems.forEach((item, idx) => {
    const card = document.getElementById(`card-${idx}`);
    const img = document.getElementById(`img-${idx}`);
    const fallback = document.getElementById(`img-fallback-${idx}`);
    const title = document.getElementById(`title-${idx}`);
    const desc = document.getElementById(`desc-${idx}`);
    const reveal = document.getElementById(`reveal-${idx}`);
    const year = document.getElementById(`year-${idx}`);
    const link = document.getElementById(`link-${idx}`);

    card.classList.remove('correct', 'wrong', 'locked');
    reveal.classList.add('hidden');

    title.textContent = item.title;
    desc.textContent = item.description;
    year.textContent = item.year;
    link.href = item.url;

    if (item.image) {
      img.src = item.image;
      img.alt = item.title;
      img.classList.remove('hidden');
      fallback.classList.add('hidden');
      img.onerror = () => {
        img.classList.add('hidden');
        fallback.classList.remove('hidden');
      };
    } else {
      img.classList.add('hidden');
      fallback.classList.remove('hidden');
    }
  });
}

function handleGuess(chosenIndex) {
  if (state.isLoading || state.roundResolved || state.currentItems.length < 2) return;
  state.roundResolved = true;

  const [item0, item1] = state.currentItems;
  const oldestIndex = item0.year < item1.year ? 0 : 1;
  const isWin = chosenIndex === oldestIndex;

  [0, 1].forEach((idx) => {
    const card = document.getElementById(`card-${idx}`);
    const reveal = document.getElementById(`reveal-${idx}`);
    card.classList.add('locked');
    reveal.classList.remove('hidden');

    if (idx === oldestIndex) {
      card.classList.add('correct');
    } else if (idx === chosenIndex && !isWin) {
      card.classList.add('wrong');
    }
  });

  const multiplier = state.difficulty === 'Facile' ? 100 : state.difficulty === 'Moyen' ? 200 : 350;

  if (isWin) {
    sfx.win();
    state.streak += 1;
    state.score += multiplier + (state.streak - 1) * 25;
    if (state.score > state.best) {
      state.best = state.score;
      localStorage.setItem('wikidefi_best', String(state.best));
    }
    dom.resultVerdict.textContent = '★ VICTOIRE ! BIEN JOUÉ ★';
    dom.resultVerdict.classList.remove('lose');
  } else {
    sfx.lose();
    state.streak = 0;
    dom.resultVerdict.textContent = '✖ RATÉ ! GAME OVER SUR LA SÉRIE';
    dom.resultVerdict.classList.add('lose');
  }

  const older = state.currentItems[oldestIndex];
  const newer = state.currentItems[1 - oldestIndex];
  const diffYears = Math.abs(newer.year - older.year);

  dom.resultDetail.textContent = `${older.title} (${older.year}) est plus ancien que ${newer.title} (${newer.year}) de ${diffYears} ans.`;
  dom.resultPanel.classList.remove('hidden');
  updateScoreboard();
}

dom.diffBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.isLoading) return;
    sfx.click();
    dom.diffBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.difficulty = btn.dataset.level;
    startNewRound();
  });
});

dom.soundToggle.addEventListener('click', () => {
  state.soundEnabled = !state.soundEnabled;
  dom.soundToggle.textContent = `SFX: ${state.soundEnabled ? 'ON' : 'OFF'}`;
  if (state.soundEnabled) sfx.click();
});

[0, 1].forEach((idx) => {
  const card = document.getElementById(`card-${idx}`);
  card.addEventListener('click', (e) => {
    if (e.target.closest('.wiki-link')) return;
    handleGuess(idx);
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleGuess(idx);
    }
  });
});

dom.newRoundBtn.addEventListener('click', () => {
  sfx.click();
  startNewRound();
});

dom.nextBtn.addEventListener('click', () => {
  sfx.click();
  startNewRound();
});

dom.retryBtn.addEventListener('click', () => {
  sfx.click();
  startNewRound();
});

updateScoreboard();
startNewRound();
