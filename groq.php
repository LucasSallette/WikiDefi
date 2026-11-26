<?php
// Empêche tout warning PHP de corrompre la sortie JSON
ini_set('display_errors', '0');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function sendError($httpStatus, $code, $title, $message, $hint = '') {
    http_response_code($httpStatus);
    echo json_encode([
        'error' => true,
        'code' => $code,
        'title' => $title,
        'message' => $message,
        'hint' => $hint
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($method === 'GET') {
    echo json_encode(['service' => 'wikidefi-groq', 'status' => 'ok']);
    exit;
}
if ($method !== 'POST') {
    header('Allow: GET, POST');
    sendError(405, 'PHP_METHOD', 'Méthode HTTP refusée', 'Le jeu envoie une requête POST pour générer un duel.');
}

// Le dossier privé HestiaCP se trouve à côté de la racine publique du domaine.
$apiKey = trim((string) getenv('GROQ_API_KEY'));
if ($apiKey === '') {
    $documentRoot = ($_SERVER['DOCUMENT_ROOT'] ?? '') ?: __DIR__;
    $envContents = @file_get_contents(dirname($documentRoot) . '/private/.env');
    if ($envContents !== false) {
        $envContents = preg_replace('/^\xEF\xBB\xBF/', '', $envContents);
        foreach (preg_split('/\R/', $envContents) as $line) {
            if (preg_match('/^\h*(?:export\h+)?GROQ_API_KEY\h*=\h*([\x22\x27]?)(gsk_[A-Za-z0-9_]+)\1(?:\h+#.*)?\h*$/', $line, $match)) {
                $apiKey = $match[2];
            }
        }
    }
}

if (!preg_match('/^gsk_[A-Za-z0-9_]{11,}$/D', $apiKey) || $apiKey === 'gsk_votre_cle_api_groq_ici') {
    sendError(
        500,
        'GROQ_CONFIG',
        'Clé Groq indisponible sur le serveur',
        'PHP ne trouve pas de clé Groq au format attendu.',
        'Placez .env dans le dossier private, à côté de public_html, ou configurez GROQ_API_KEY dans PHP.'
    );
}

// 2. Lecture de la requête envoyée par script.js
$rawInput = file_get_contents('php://input', false, null, 0, 16385);
if ($rawInput === false || strlen($rawInput) > 16384) {
    sendError(400, 'PHP_REQUEST', 'Requête de jeu invalide', 'Le serveur attend les paramètres du duel au format JSON.');
}
$input = json_decode($rawInput, true);
if (!is_array($input)) {
    sendError(400, 'PHP_REQUEST', 'Requête de jeu invalide', 'Le serveur attend les paramètres du duel au format JSON.');
}

$difficulty = is_string($input['difficulty'] ?? null) ? $input['difficulty'] : 'Facile';
$excluded = (isset($input['excluded']) && is_array($input['excluded']))
    ? array_filter(array_slice($input['excluded'], -30), static function ($title) {
        return is_string($title) && strlen($title) <= 255;
    })
    : [];

$difficultyGuides = [
    'Facile' => 'Sujets très célèbres et grand public avec des titres Wikipédia simples et courts (ex: "Tour Eiffel", "Nintendo", "Coca-Cola", "Titanic", "Pyramide de Khéops", "Internet").',
    'Moyen'  => 'Inventions, monuments, œuvres, entreprises ou institutions connues avec des titres Wikipédia officiels (ex: "Métro de Paris", "Tour de Pise", "Lego", "Statue de la Liberté", "Cinéma").',
    'Avancé' => 'Éléments historiques, scientifiques ou culturels plus pointus mais possédant un article Wikipédia francophone principal bien établi (ex: "Télécopieur", "Université d\'Oxford", "Walkman", "Pac-Man", "Astrolabe").'
];

$guide = isset($difficultyGuides[$difficulty]) ? $difficultyGuides[$difficulty] : $difficultyGuides['Facile'];
$excludedText = count($excluded) > 0
    ? 'Ne propose AUCUN de ces sujets déjà joués : ' . implode(', ', $excluded) . '.'
    : '';

$systemPrompt = "Tu es le générateur de défis de WikiDéfi. Tu dois fournir exactement 4 sujets réels distincts possédant un article principal sur Wikipédia en français, avec une année de création, fondation, construction ou invention précise.\n\n"
    . "RÈGLES ANTI-ERREUR STRICTES :\n"
    . "1. \"wikiTitle\" doit être le TITRE EXACT et COURT de l'article principal sur fr.wikipedia.org (exemple : écris \"Imprimerie\" et NON \"Imprimerie à caractères mobiles\" ; écris \"Téléphone\" et NON \"Invention du téléphone\").\n"
    . "2. \"searchQuery\" doit contenir 2 à 3 mots-clés simples permettant de retrouver l'article sur Wikipédia FR.\n"
    . "3. Les 4 éléments doivent tous avoir des années différentes (écart minimum de 15 ans entre chaque).\n"
    . "4. \"description\" doit décrire en 1 à 2 phrases courtes ce qu'est l'élément, SANS JAMAIS écrire de date, d'année, de siècle ni d'indice d'époque.\n"
    . "5. Réponds UNIQUEMENT en JSON valide au format exact :\n"
    . "{\n"
    . "  \"items\": [\n"
    . "    { \"wikiTitle\": \"Tour Eiffel\", \"searchQuery\": \"Tour Eiffel Paris\", \"description\": \"Monument en fer puddlé situé au Champ-de-Mars à Paris.\", \"estimatedYear\": 1889 }\n"
    . "  ]\n"
    . "}";

$userPrompt = "Difficulté : {$difficulty}.\nConsigne : {$guide}\n{$excludedText}\nGénère 4 sujets variés de différentes époques.";

$payload = json_encode([
    'model' => 'openai/gpt-oss-120b',
    'reasoning_effort' => 'low',
    'max_completion_tokens' => 2048,
    'temperature' => 0.75,
    'response_format' => ['type' => 'json_object'],
    'messages' => [
        ['role' => 'system', 'content' => $systemPrompt],
        ['role' => 'user', 'content' => $userPrompt]
    ]
]);

// 3. Requête vers Groq (via cURL si dispo, sinon fallback file_get_contents)
$apiUrl = 'https://api.groq.com/openai/v1/chat/completions';
$responseBody = false;
$httpCode = 0;
$netError = '';

if (function_exists('curl_init')) {
    $ch = curl_init($apiUrl);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'Authorization: Bearer ' . $apiKey
        ],
        CURLOPT_POSTFIELDS => $payload
    ]);
    $responseBody = curl_exec($ch);
    $netError = curl_error($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
} else {
    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\nAuthorization: Bearer {$apiKey}\r\n",
            'content' => $payload,
            'timeout' => 20,
            'ignore_errors' => true
        ]
    ]);
    $responseBody = @file_get_contents($apiUrl, false, $context);
    if (isset($http_response_header[0]) && preg_match('#HTTP/\S+\s+(\d{3})#', $http_response_header[0], $m)) {
        $httpCode = (int) $m[1];
    }
    if ($responseBody === false) {
        $netError = 'Échec stream HTTP PHP (cURL absent).';
    }
}

if ($responseBody === false) {
    sendError(
        502,
        'GROQ_NET',
        'Impossible de joindre l’API Groq depuis PHP',
        'Détail serveur : ' . ($netError ?: 'Connexion sortante bloquée.'),
        'Vérifiez que les requêtes HTTPS sortantes sont autorisées sur votre hébergement.'
    );
}

if ($httpCode === 401 || $httpCode === 403) {
    sendError(
        $httpCode,
        'GROQ_' . $httpCode,
        'Clé API Groq refusée',
        'Groq a rejeté votre clé API (invalide ou expirée).',
        'Vérifiez votre clé GROQ_API_KEY sur console.groq.com et mettez à jour .env.'
    );
}

if ($httpCode === 429) {
    sendError(
        429,
        'GROQ_429',
        'Limite de requêtes Groq atteinte',
        'Trop de requêtes ont été envoyées en peu de temps.',
        'Patientez quelques secondes avant de cliquer sur RÉESSAYER.'
    );
}

if ($httpCode < 200 || $httpCode >= 300) {
    sendError(
        $httpCode ?: 500,
        'GROQ_' . ($httpCode ?: 'ERR'),
        'Erreur serveur Groq AI',
        "L'API Groq a renvoyé un code HTTP {$httpCode}.",
        'Cliquez sur RÉESSAYER dans un instant.'
    );
}

$decoded = json_decode($responseBody, true);
$content = isset($decoded['choices'][0]['message']['content']) ? $decoded['choices'][0]['message']['content'] : '';
$content = preg_replace('/^```(?:json)?\s*|\s*```$/m', '', trim($content));
$parsed = json_decode($content, true);

if (!is_array($parsed['items'] ?? null) || count($parsed['items']) < 2) {
    sendError(
        502,
        'GROQ_BAD_JSON',
        'Format de réponse IA invalide',
        'Groq AI n’a pas renvoyé la liste d’éléments attendue.',
        'Cliquez sur RÉESSAYER pour relancer une génération.'
    );
}

echo json_encode([
    'error' => false,
    'items' => $parsed['items']
], JSON_UNESCAPED_UNICODE);
