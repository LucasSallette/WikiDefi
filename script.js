/**
 * WikiDéfi - Logique principale
 * - Génération des paires et descriptions sans dates via groq.php
 * - Vérification des images et des dates via l'API Wikipédia FR
 */

class WikiDefiError extends Error {
  constructor(code, title, message, hint = '') {
    super(message);
    this.code = code;
    this.title = title;
    this.hint = hint;
  }
}

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

// Effets sonores 8-bit (Web Audio API)
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
    // Ignoré si bloqué avant interaction utilisateur
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

/**
 * Masque toute année ou siècle qui aurait pu glisser dans la description
 */
function sanitizeDescription(text) {
  return text
    .replace(/\b(1[0-9]{3}|20[0-2][0-9])\b/g, '[date masquée]')
    .replace(/\b(XIXe|XXe|XXIe|XVIIIe|XVIIe|XVIe)\s+siècle\b/gi, 'époque passée')
    .trim();
}

/**
 * Demande 2 éléments à l'API Groq selon le niveau choisi
 */
async function fetchPairFromGroq() {
  if (window.location.protocol === 'file:') {
    throw new WikiDefiError(
      'PHP_REQUIRED',
      'Serveur PHP requis',
      'Le jeu doit être ouvert depuis un site qui exécute groq.php.',
      'Ouvrez l’adresse HTTP ou HTTPS du site.'
    );
  }

  let res;
  try {
    res = await fetch('./groq.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        difficulty: state.difficulty,
        excludedTitles: Array.from(state.usedTitles).slice(-20),
      }),
    });
  } catch {
    throw new WikiDefiError(
      'GROQ_NET',
      'Serveur du jeu injoignable',
      'Le navigateur n’a pas pu joindre groq.php.',
      'Vérifiez votre connexion et réessayez.'
    );
  }

  const data = await res.json().catch(() => null);
  if (!data || res.status === 404) {
    throw new WikiDefiError(
      'PHP_ENDPOINT',
      'Réponse PHP indisponible',
      'Le serveur du jeu n’a pas renvoyé la réponse attendue.',
      'Vérifiez que groq.php est publié à côté de index.html et que PHP est actif sur le domaine.'
    );
  }

  if (data.error === 'GROQ_CONFIG') {
    throw new WikiDefiError(
      'GROQ_CONFIG',
      'Clé Groq manquante ou illisible sur le serveur',
      'PHP n’a pas trouvé de clé au format attendu.',
      'Configurez GROQ_API_KEY sur le serveur ou placez le fichier dans private/.env, à côté de public_html.'
    );
  }

  if (data.error === 'PHP_CURL_MISSING' || data.error === 'GROQ_TRANSPORT') {
    throw new WikiDefiError(
      data.error,
      'Le serveur du jeu ne parvient pas à joindre Groq',
      data.error === 'PHP_CURL_MISSING'
        ? 'L’extension PHP cURL est indisponible.'
        : 'La connexion du serveur à api.groq.com a échoué.',
      'Vérifiez l’extension PHP cURL et l’accès HTTPS sortant du serveur.'
    );
  }

  const upstreamStatus = data.upstreamStatus;
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    throw new WikiDefiError(
      'GROQ ' + upstreamStatus,
      'Accès à Groq refusé',
      'Groq a refusé la clé ou l’accès au modèle.',
      'Vérifiez la clé et les autorisations du projet dans la console Groq.'
    );
  }

  if (res.status === 429) {
    throw new WikiDefiError(
      'GROQ 429',
      'Limite de requêtes Groq atteinte',
      'Groq a limité les requêtes.',
      'Patientez un instant avant de réessayer.'
    );
  }

  if (data.error === 'GROQ_EMPTY') {
    throw new WikiDefiError(
      'GROQ_EMPTY',
      'Réponse vide de Groq AI',
      'L’IA n’a renvoyé aucun contenu.',
      'Cliquez sur RÉESSAYER.'
    );
  }

  if (!res.ok) {
    throw new WikiDefiError(
      upstreamStatus ? 'GROQ ' + upstreamStatus : 'HTTP ' + res.status,
      'Impossible de générer le duel',
      'Le serveur du jeu ou Groq a renvoyé une erreur.',
      'Réessayez dans un instant.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(data.content);
  } catch {
    throw new WikiDefiError(
      'JSON_PARSE',
      'Format de réponse IA invalide',
      'La réponse renvoyée par Groq n’était pas un JSON valide.',
      'Cliquez sur RÉESSAYER pour relancer.'
    );
  }

  const items = parsed?.items;
  if (!Array.isArray(items) || items.length < 2 || items.slice(0, 2).some((item) => (
    typeof item?.wikiTitle !== 'string' || !item.wikiTitle.trim() ||
    typeof item.description !== 'string' || !Number.isInteger(Number(item.estimatedYear)) || !Number(item.estimatedYear)
  ))) {
    throw new WikiDefiError(
      'INVALID_PAIR',
      'Paire d’éléments incomplète',
      'Groq AI n’a pas renvoyé deux éléments comparables.',
      'Cliquez sur RÉESSAYER.'
    );
  }

  return items.slice(0, 2);
}

/**
 * Récupère l'image, le lien et confirme l'année via l'API Wikipédia FR
 */
async function enrichWithWikipedia(aiItem) {
  const encodedTitle = encodeURIComponent(aiItem.wikiTitle.trim());
  const summaryUrl = `https://fr.wikipedia.org/api/rest_v1/page/summary/${encodedTitle}`;

  let res;
  try {
    res = await fetch(summaryUrl, {
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new WikiDefiError(
      'WIKI_NET',
      'Connexion impossible à Wikipédia',
      'Impossible de joindre fr.wikipedia.org.',
      'Vérifiez votre connexion Internet.'
    );
  }

  if (res.status === 404) {
    throw new WikiDefiError(
      'WIKI 404',
      `Page Wikipédia introuvable : "${aiItem.wikiTitle}"`,
      'L’élément généré n’existe pas sous ce titre sur Wikipédia FR.',
      'Cliquez sur RÉESSAYER pour tirer un autre duel.'
    );
  }

  if (!res.ok) {
    throw new WikiDefiError(
      `WIKI ${res.status}`,
      'Erreur API Wikipédia',
      `Wikipédia a renvoyé un statut HTTP ${res.status}.`,
      'Réessayez dans quelques secondes.'
    );
  }

  const wikiData = await res.json();

  if (wikiData.type === 'disambiguation') {
    throw new WikiDefiError(
      'WIKI_AMBIGUOUS',
      `Page d’homonymie : "${wikiData.title}"`,
      'Ce sujet correspond à plusieurs pages Wikipédia différentes.',
      'Cliquez sur RÉESSAYER pour générer une paire plus précise.'
    );
  }

  const extractText = wikiData.extract || '';
  const yearMatches = extractText.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/g);
  let verifiedYear = Number(aiItem.estimatedYear);

  if (yearMatches && yearMatches.length > 0) {
    const numericYears = yearMatches.map(Number);
    numericYears.sort((a, b) => Math.abs(a - verifiedYear) - Math.abs(b - verifiedYear));
    if (Math.abs(numericYears[0] - verifiedYear) <= 25) {
      verifiedYear = numericYears[0];
    }
  }

  if (!verifiedYear || Number.isNaN(verifiedYear)) {
    throw new WikiDefiError(
      'NO_DATE',
      `Date introuvable pour "${wikiData.title}"`,
      'Impossible d’extraire une année de référence valide.',
      'Cliquez sur RÉESSAYER.'
    );
  }

  return {
    title: wikiData.title,
    description: sanitizeDescription(aiItem.description),
    image: wikiData.thumbnail?.source || wikiData.originalimage?.source || null,
    url: wikiData.content_urls?.desktop?.page || `https://fr.wikipedia.org/wiki/${encodedTitle}`,
    year: verifiedYear,
  };
}

function showError(err) {
  sfx.error();
  dom.loader.classList.add('hidden');
  dom.cardsGrid.classList.add('hidden');
  dom.resultPanel.classList.add('hidden');

  dom.errorCode.textContent = err.code || 'ERREUR';
  dom.errorTitle.textContent = err.title || 'Erreur inattendue';
  dom.errorMessage.textContent = err.message || 'Une erreur inconnue est survenue.';

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

  try {
    dom.loaderText.textContent = `GÉNÉRATION DU DUEL (${state.difficulty.toUpperCase()}) VIA GROQ AI...`;
    const aiPair = await fetchPairFromGroq();

    dom.loaderText.textContent = 'VÉRIFICATION DES ARTICLES & IMAGES SUR WIKIPÉDIA...';
    const [item0, item1] = await Promise.all([
      enrichWithWikipedia(aiPair[0]),
      enrichWithWikipedia(aiPair[1]),
    ]);

    if (item0.year === item1.year) {
      throw new WikiDefiError(
        'EQUAL_DATES',
        'Égalité chronologique détectée',
        `Les deux éléments datent de la même année (${item0.year}).`,
        'Cliquez sur RÉESSAYER pour obtenir deux époques différentes.'
      );
    }

    state.currentItems = [item0, item1];
    state.usedTitles.add(item0.title);
    state.usedTitles.add(item1.title);

    renderCards();
    dom.loader.classList.add('hidden');
    dom.cardsGrid.classList.remove('hidden');
  } catch (err) {
    const normalizedError =
      err instanceof WikiDefiError
        ? err
        : new WikiDefiError('UNKNOWN', 'Erreur critique', err.message || String(err));
    showError(normalizedError);
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
