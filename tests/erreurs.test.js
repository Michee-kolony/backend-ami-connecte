// Messages d'erreur : toujours en français (validation Mongoose, JSON mal formé, fichiers,
// identifiants invalides, routes inconnues). Base MongoDB en mémoire, données fictives.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');

let serveurMongo;
let api;
let http;
let mongoose;
let jeton;

/** Aucune tournure anglaise des bibliothèques (Mongoose, Express, body-parser, multer). */
const ANGLAIS = /\b(Path|is required|Cast to|failed|Unexpected|token|is not a valid|allowed|Cannot|Not Found|Bad Request)\b/;

async function appel(methode, chemin, corps, { brut = false, avecJeton = true } = {}) {
  const r = await fetch(`${api}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', ...(avecJeton ? { Authorization: `Bearer ${jeton}` } : {}) },
    body: corps === undefined ? undefined : brut ? corps : JSON.stringify(corps),
  });
  return { status: r.status, corps: await r.json() };
}

function enFrancais(r) {
  assert.ok(r.corps?.message, 'un message est renvoyé');
  assert.doesNotMatch(r.corps.message, ANGLAIS, r.corps.message);
}

before(async () => {
  serveurMongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = serveurMongo.getUri('ami_connecte_essai_erreurs');
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  const app = require('../app');
  mongoose = require('mongoose');
  await mongoose.connection.asPromise();
  const Soignant = require('../models/Soignant');
  const jwt = require('jsonwebtoken');
  const medecin = await Soignant.create({
    prenom: 'Marie', nom: 'ERREUR', role: 'Médecin', matricule: 'MED-9301', affectations: [{ etablissementId: 'ETS-T' }], email: 'erreurs@essai.test', motDePasse: 'x',
    postnom: 'TEST', sexe: 'F', dateNaissance: '1985-01-01', lieuNaissance: 'Kinshasa', nationalite: 'Congolaise',
    pieceType: 'Passeport', adresse: 'Fictive', telephone: '000', grade: 'Fictif', specialite: 'Fictive',
  });
  jeton = jwt.sign({ sub: medecin.id, role: 'Médecin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  http = app.listen(0);
  await new Promise((r) => http.once('listening', r));
  api = `http://127.0.0.1:${http.address().port}/api`;
});

after(async () => {
  http?.close();
  await mongoose?.disconnect();
  await serveurMongo?.stop();
});

test('validation Mongoose : messages par défaut traduits, avec le nom lisible du champ', () => {
  const Patiente = require('../models/Patiente');
  const { messageValidation } = require('../config/erreursFr');
  const p = new Patiente({ numero: 'AC-PAT-1', nom: 'A', tailleCm: 50, etatCivil: 'Pacsée', creePar: { id: '1', nom: 'a', role: 'b' } });
  return p.validate().then(() => assert.fail('validation attendue'), (err) => {
    const messages = Object.values(err.errors).map((e) => e.message).join(' | ');
    assert.match(messages, /« taille \(cm\) » doit être supérieur ou égal à 100/);
    assert.match(messages, /Valeur « Pacsée » non autorisée pour « état civil »/);
    assert.doesNotMatch(messages, ANGLAIS);
    assert.match(messageValidation(err), /\S/);
  });
});

test('JSON mal formé, identifiant invalide, route inconnue, jeton invalide : réponses en français', async () => {
  const json = await appel('POST', '/auth/connexion', '{"email": ', { brut: true });
  assert.equal(json.status, 400);
  enFrancais(json);
  assert.match(json.corps.message, /format JSON incorrect/);

  const inconnue = await appel('GET', '/route-inexistante');
  assert.equal(inconnue.status, 404);
  enFrancais(inconnue);

  const adresse = await appel('GET', '/accouchements/%E0%A4%A');
  assert.ok(adresse.status >= 400 && adresse.status < 500);
  enFrancais(adresse);

  const session = await fetch(`${api}/accouchements`, { headers: { Authorization: 'Bearer faux.jeton.signe' } });
  const corps = await session.json();
  assert.equal(session.status, 401);
  assert.doesNotMatch(corps.message, ANGLAIS);
});

test('fichier refusé (multer) et erreur de conversion : réponses en français', async () => {
  const f = new FormData();
  f.append('donnees', '{}');
  f.append('photo', new Blob(['texte'], { type: 'text/plain' }), 'note.txt');
  const r = await fetch(`${api}/patientes`, { method: 'POST', headers: { Authorization: `Bearer ${jeton}` }, body: f });
  const corps = await r.json();
  assert.equal(r.status, 400);
  assert.doesNotMatch(corps.message, ANGLAIS);

  const { traduire } = require('../config/erreursFr');
  const Enfant = require('../models/Enfant');
  const conversion = traduire(new mongoose.Error.CastError('Number', 'abc', 'naissance.poidsG'));
  assert.equal(conversion.status, 400);
  assert.match(conversion.message, /« poids \(g\) » : un nombre est attendu/);
  assert.ok(Enfant);
});
