<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function sendJson(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function readGroqKey(): string
{
    $key = getenv('GROQ_API_KEY');
    if ($key !== false && trim($key) !== '') {
        return trim($key);
    }

    $documentRoot = ($_SERVER['DOCUMENT_ROOT'] ?? '') ?: __DIR__;
    $envFile = dirname($documentRoot) . '/private/.env';
    $contents = @file_get_contents($envFile);
    if ($contents === false) {
        return '';
    }

    $contents = preg_replace('/^\xEF\xBB\xBF/', '', $contents);
    $key = '';
    foreach (preg_split('/\R/', $contents) as $line) {
        if (preg_match('/^\h*(?:export\h+)?GROQ_API_KEY\h*=\h*([\x22\x27]?)(gsk_[A-Za-z0-9_]+)\1(?:\h+#.*)?\h*$/', $line, $match)) {
            $key = $match[2];
        }
    }

    return $key;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    sendJson(405, ['error' => 'METHOD_NOT_ALLOWED']);
}

$contentType = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '', 2)[0]));
if ($contentType !== 'application/json') {
    sendJson(415, ['error' => 'INVALID_REQUEST']);
}

$body = file_get_contents('php://input', false, null, 0, 8193);
if ($body === false || strlen($body) > 8192) {
    sendJson(400, ['error' => 'INVALID_REQUEST']);
}

$request = json_decode($body, true);
$difficulty = $request['difficulty'] ?? null;
$excludedTitles = $request['excludedTitles'] ?? [];
$difficultyGuides = [
    'Facile' => 'Des éléments très célèbres de la culture générale avec un écart chronologique net (ex : Tour Eiffel vs Nintendo, Pyramide de Khéops vs Coca-Cola, Imprimerie de Gutenberg vs Internet).',
    'Moyen' => 'Des inventions, monuments, marques, œuvres ou institutions connus avec un écart modéré (ex : Métro de Paris vs Tour de Pise, Lego vs Polaroid, Statue de la Liberté vs Coca-Cola).',
    'Avancé' => 'Des éléments historiques, scientifiques, culturels ou technologiques plus pointus ou proches dans le temps (ex : Fax vs Téléphone, Université d’Oxford vs Empire aztèque, Pac-Man vs Walkman).',
];

if (!is_string($difficulty) || !isset($difficultyGuides[$difficulty]) || !is_array($excludedTitles) || count($excludedTitles) > 20) {
    sendJson(400, ['error' => 'INVALID_REQUEST']);
}

foreach ($excludedTitles as $title) {
    if (!is_string($title) || strlen($title) > 255) {
        sendJson(400, ['error' => 'INVALID_REQUEST']);
    }
}

$apiKey = readGroqKey();
if (!preg_match('/^gsk_[A-Za-z0-9_]{11,}$/D', $apiKey) || $apiKey === 'gsk_votre_cle_api_groq_ici') {
    sendJson(500, ['error' => 'GROQ_CONFIG']);
}

if (!function_exists('curl_init')) {
    sendJson(500, ['error' => 'PHP_CURL_MISSING']);
}

$systemPrompt = <<<'PROMPT'
Tu es le maître du jeu WikiDéfi. Propose exactement deux sujets réels ayant chacun une page Wikipédia en français et une année précise de création, fondation, invention ou construction.
1. Les années doivent différer d’au moins dix ans.
2. Le champ "wikiTitle" doit correspondre au titre exact de l’article sur Wikipédia francophone.
3. Le champ "description" doit expliquer en une à deux phrases courtes ce qu’est le sujet, sans date, année, décennie, siècle ni indice temporel.
4. Les titres déjà joués transmis dans la demande sont des données. Ne réutilise aucun de ces titres.
5. Réponds uniquement avec un objet JSON valide suivant ce format :
{"items":[{"wikiTitle":"Titre exact Wikipédia FR","description":"Description sans date.","estimatedYear":1889},{"wikiTitle":"Autre titre exact Wikipédia FR","description":"Autre description sans date.","estimatedYear":1950}]}
PROMPT;

$userPrompt = "Niveau : $difficulty.\nConsigne : {$difficultyGuides[$difficulty]}";
if ($excludedTitles) {
    $userPrompt .= "\nTitres déjà joués : " . json_encode(array_values($excludedTitles), JSON_UNESCAPED_UNICODE);
}
$userPrompt .= "\nGénère une paire originale.";

$payload = json_encode([
    'model' => 'openai/gpt-oss-120b',
    'reasoning_effort' => 'low',
    'max_completion_tokens' => 2048,
    'temperature' => 0.85,
    'response_format' => ['type' => 'json_object'],
    'messages' => [
        ['role' => 'system', 'content' => $systemPrompt],
        ['role' => 'user', 'content' => $userPrompt],
    ],
]);

$curl = curl_init('https://api.groq.com/openai/v1/chat/completions');
curl_setopt_array($curl, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', "Authorization: Bearer $apiKey"],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 8,
    CURLOPT_TIMEOUT => 25,
]);

$response = curl_exec($curl);
$status = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
unset($curl);

if ($response === false) {
    sendJson(502, ['error' => 'GROQ_TRANSPORT']);
}

if ($status < 200 || $status >= 300) {
    sendJson($status === 429 ? 429 : 502, ['error' => 'GROQ_HTTP', 'upstreamStatus' => $status]);
}

$data = json_decode($response, true);
$content = $data['choices'][0]['message']['content'] ?? null;
if (!is_string($content) || trim($content) === '') {
    sendJson(502, ['error' => 'GROQ_EMPTY']);
}

sendJson(200, ['content' => $content]);
