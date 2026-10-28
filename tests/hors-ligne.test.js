// Mode hors connexion, côté serveur : idempotence (OFF-06, OFF-07), conflits entre appareils
// (OFF-08), droits inchangés (OFF-09), révocation d'un appareil perdu (OFF-10), identifiants pour la
// résolution des références locales (mère → grossesse → consultation) et journal des synchronisations.
// Base MongoDB en mémoire, données fictives : aucune donnée réelle n'est lue ni écrite.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');

let serveurMongo;
let api;
let http;
let mongoose;
const jetons = {};
const ids = {};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function appel(qui, methode, chemin, corps, entetes = {}) {
  const r = await fetch(`${api}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jetons[qui] ?? qui}`, ...entetes },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  return { status: r.status, corps: texte ? JSON.parse(texte) : null };
}

before(async () => {
  serveurMongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = serveurMongo.getUri('ami_connecte_essai_hors_ligne');
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  const r2 = require('../config/r2');
  r2.envoyerFichier = async (f, dossier) => ({ cle: `${dossier}/essai.png`, url: `https://public.invalid/${dossier}/essai.png` });
  r2.supprimerFichier = async () => {};
  r2.urlSignee = async (cle) => (cle ? `https://signe.invalid/${cle}` : null);
  const app = require('../app');
  mongoose = require('mongoose');
  await mongoose.connection.asPromise();
  const jwt = require('jsonwebtoken');
  const Etablissement = require('../models/Etablissement');
  const Soignant = require('../models/Soignant');
  const etab = await Etablissement.create({
    code: 'ETS-KIN-9801', nom: 'CS Essai', type: 'Centre de santé', secteur: 'Public', province: 'Kinshasa', zoneSante: 'Z', aireSante: 'A',
    adresse: 'Fictive', telephone: '0', responsable: 'Fictif', services: ['CPN'],
  });
  ids.etab = etab.id;
  const base = {
    postnom: '', sexe: 'F', dateNaissance: '1985-01-01', lieuNaissance: 'Kinshasa', nationalite: 'Congolaise', pieceType: 'Passeport',
    adresse: 'Fictive', telephone: '0', grade: 'Fictif', specialite: 'Fictive', motDePasse: 'x', affectations: [{ etablissementId: etab.id }],
  };
  for (const [cle, role, matricule] of [['chef', 'Médecin chef de service', 'MED-9801'], ['medecinA', 'Médecin', 'MED-9802'], ['medecinB', 'Médecin', 'MED-9803'], ['infirmiere', 'Infirmier(ère)', 'INF-9801']]) {
    const s = await Soignant.create({ ...base, prenom: cle, nom: 'ESSAI', role, matricule, email: `${cle}@hl.test` });
    ids[cle] = s.id;
    // Jeton émis une seconde dans le passé : la révocation (à la seconde) le vise bien.
    jetons[cle] = jwt.sign({ sub: s.id, etablissement: etab.id, iat: Math.floor(Date.now() / 1000) - 2 }, process.env.JWT_SECRET);
  }
  http = app.listen(0);
  await new Promise((r) => http.once('listening', r));
  api = `http://127.0.0.1:${http.address().port}/api`;
});

after(async () => {
  http?.close();
  await mongoose?.disconnect();
  await serveurMongo?.stop();
});

test('création hors ligne : la réponse donne les identifiants pour résoudre les références locales', async () => {
  const f = new FormData();
  f.append('donnees', JSON.stringify({
    patiente: { nom: 'Locale', prenom: 'Mère', dateNaissance: '1995-02-02', email: 'mere.locale@hl.test', adresse: { province: 'Kinshasa' } },
    grossesse: { datation: { methode: 'DDR', ddr: new Date(Date.now() - 80 * 86400000).toISOString().slice(0, 10) } },
    compte: { motDePasse: 'Maman2026' }, confirmerMalgreDoublons: true,
  }));
  f.append('photo', new Blob([PNG], { type: 'image/png' }), 'p.png');
  const r = await fetch(`${api}/patientes`, { method: 'POST', headers: { Authorization: `Bearer ${jetons.medecinA}`, 'X-Operation-Id': 'op-hl-creation-001', 'X-Appareil': 'app-essai-01', 'X-Saisie-Le': '2026-10-28T08:00:00.000Z' }, body: f });
  const c = await r.json();
  assert.equal(r.status, 201, JSON.stringify(c));
  assert.ok(c.id && c.numero && c.grossesseId, 'id, numero et grossesseId (consultation créée hors ligne sur cette grossesse)');
  ids.patiente = c.id;
  ids.grossesse = c.grossesseId;

  // Consultation saisie hors ligne sur la grossesse locale, envoyée après résolution de l'identifiant.
  const cons = await appel('medecinA', 'POST', `/grossesses/${c.grossesseId}/consultations`, { type: 'Première consultation prénatale', motif: 'CPN 1' }, { 'X-Operation-Id': 'op-hl-consultation-001' });
  assert.equal(cons.status, 201, JSON.stringify(cons.corps));
  ids.consultation = cons.corps.id;
});

test('OFF-06 / OFF-07 : le même lot renvoyé (coupure pendant l’envoi) ne crée aucun doublon', async () => {
  const Consultation = require('../models/Consultation');
  const avant = await Consultation.countDocuments({ grossesseId: ids.grossesse });
  const reponses = [];
  for (let k = 0; k < 3; k++) {
    const r = await appel('medecinA', 'POST', `/grossesses/${ids.grossesse}/consultations`, { type: 'Suivi prénatal', motif: 'CPN 2' }, { 'X-Operation-Id': 'op-hl-lot-consultation-002' });
    assert.equal(r.status, 201);
    reponses.push(r.corps);
  }
  assert.equal(await Consultation.countDocuments({ grossesseId: ids.grossesse }), avant + 1, 'une seule consultation pour trois envois');
  // Le rejeu renvoie le même corps, identifiant compris : l'appareil peut relier son identifiant local.
  assert.ok(reponses[0].id);
  assert.deepEqual(reponses[1], reponses[0]);
  assert.deepEqual(reponses[2], reponses[0]);

  // Idem pour un document renvoyé tel quel par le contrôleur (rendez-vous) : `id`, pas `_id`.
  const rdv = { date: new Date(Date.now() + 40 * 86400000).toISOString(), motif: 'Rejeu' };
  const r1 = await appel('medecinA', 'POST', `/patientes/${ids.patiente}/rendez-vous`, rdv, { 'X-Operation-Id': 'op-hl-lot-rdv-0003' });
  const r2 = await appel('medecinA', 'POST', `/patientes/${ids.patiente}/rendez-vous`, rdv, { 'X-Operation-Id': 'op-hl-lot-rdv-0003' });
  assert.equal(r1.status, 201);
  assert.ok(r1.corps.id);
  assert.deepEqual(r2.corps, r1.corps);
});

test('OFF-08 : la même patiente modifiée sur deux appareils → conflit, rien n’est écrasé', async () => {
  const d = await appel('medecinA', 'GET', `/patientes/${ids.patiente}`);
  const versionAppareilA = d.corps.patiente.updatedAt;
  // Appareil B (en ligne) modifie le téléphone.
  await new Promise((r) => setTimeout(r, 1200));
  const b = await appel('medecinB', 'PATCH', `/patientes/${ids.patiente}`, { telephone: '+243 81 222 2222' });
  assert.equal(b.status, 200);
  // Appareil A (hors ligne, version plus ancienne) envoie sa modification à la reconnexion.
  const a = await appel('medecinA', 'PATCH', `/patientes/${ids.patiente}`, { telephone: '+243 81 111 1111' }, { 'X-Version-Base': versionAppareilA, 'X-Operation-Id': 'op-hl-conflit-001' });
  assert.equal(a.status, 409);
  assert.equal(a.corps.conflit, true);
  assert.match(a.corps.message, /Conflit/);
  const apres = await appel('medecinA', 'GET', `/patientes/${ids.patiente}`);
  assert.equal(apres.corps.patiente.telephone, '+243 81 222 2222', 'la modification de B n’est pas écrasée');
  // Décision humaine « appliquer quand même » : renvoi sans version de base.
  const force = await appel('medecinA', 'PATCH', `/patientes/${ids.patiente}`, { telephone: '+243 81 111 1111' }, { 'X-Operation-Id': 'op-hl-conflit-002' });
  assert.equal(force.status, 200);
  // Version à jour : pas de conflit.
  const v = (await appel('medecinA', 'GET', `/patientes/${ids.patiente}`)).corps.patiente.updatedAt;
  assert.equal((await appel('medecinA', 'PATCH', `/patientes/${ids.patiente}`, { occupation: 'Couturière' }, { 'X-Version-Base': v })).status, 200);
});

test('OFF-08 : rendez-vous changé sur deux appareils → conflit ; ajouts (consultations) jamais en conflit', async () => {
  const rdv = await appel('medecinA', 'POST', `/patientes/${ids.patiente}/rendez-vous`, { date: new Date(Date.now() + 5 * 86400000).toISOString(), motif: 'CPN 3' });
  assert.equal(rdv.status, 201, JSON.stringify(rdv.corps));
  const version = rdv.corps.updatedAt;
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal((await appel('medecinB', 'PATCH', `/rendez-vous/${rdv.corps.id}`, { action: 'confirmer' })).status, 200);
  const conflit = await appel('medecinA', 'PATCH', `/rendez-vous/${rdv.corps.id}`, { action: 'annuler', motif: 'Patiente indisponible' }, { 'X-Version-Base': version });
  assert.equal(conflit.status, 409);
  assert.equal(conflit.corps.conflit, true);
  // Deux consultations ajoutées par deux appareils : les deux sont gardées.
  const Consultation = require('../models/Consultation');
  const avant = await Consultation.countDocuments({ grossesseId: ids.grossesse });
  await appel('medecinA', 'POST', `/grossesses/${ids.grossesse}/consultations`, { type: 'Suivi prénatal' }, { 'X-Version-Base': version });
  await appel('medecinB', 'POST', `/grossesses/${ids.grossesse}/consultations`, { type: 'Suivi prénatal' });
  assert.equal(await Consultation.countDocuments({ grossesseId: ids.grossesse }), avant + 2);
});

test('OFF-09 : hors ligne ne contourne aucun droit (rejeu d’une saisie interdite → 403)', async () => {
  const r = await appel('infirmiere', 'POST', `/grossesses/${ids.grossesse}/consultations`, { type: 'Suivi prénatal' }, { 'X-Operation-Id': 'op-hl-interdit-001' });
  assert.equal(r.status, 403);
  // Rejouée, elle reste refusée (une opération en échec n'est jamais mémorisée comme réussie).
  const r2 = await appel('infirmiere', 'POST', `/grossesses/${ids.grossesse}/consultations`, { type: 'Suivi prénatal' }, { 'X-Operation-Id': 'op-hl-interdit-001' });
  assert.equal(r2.status, 403);
});

test('OFF-10 : appareil perdu → sessions révoquées, l’application est invitée à effacer ses données', async () => {
  assert.equal((await appel('medecinB', 'GET', '/patientes')).status, 200);
  assert.equal((await appel('medecinA', 'POST', `/soignants/${ids.medecinB}/revoquer-sessions`)).status, 403, 'réservé au médecin chef');
  const rev = await appel('chef', 'POST', `/soignants/${ids.medecinB}/revoquer-sessions`);
  assert.equal(rev.status, 200);
  const refus = await appel('medecinB', 'GET', '/patientes');
  assert.equal(refus.status, 401);
  assert.equal(refus.corps.revoque, true, 'signal d’effacement des données locales');
  // Une session expirée (pas révoquée) ne demande pas d'effacement.
  const jwt = require('jsonwebtoken');
  const expire = jwt.sign({ sub: ids.medecinA, exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET);
  const r = await appel(expire, 'GET', '/patientes');
  assert.equal(r.status, 401);
  assert.notEqual(r.corps.revoque, true);
});

test('journal : chaque saisie synchronisée garde l’appareil, l’opération et l’heure de saisie, sans contenu clinique', async () => {
  const JournalAudit = require('../models/JournalAudit');
  const j = await JournalAudit.findOne({ action: 'patiente.creation', 'details.operationId': 'op-hl-creation-001' });
  assert.ok(j, 'entrée de journal');
  assert.equal(j.details.appareil, 'app-essai-01');
  assert.equal(j.details.saisieLe, '2026-10-28T08:00:00.000Z');
  assert.ok(!JSON.stringify(j).includes('Locale'), 'aucune donnée de la patiente');
  assert.ok(await JournalAudit.exists({ action: 'soignant.revocation' }));
});
