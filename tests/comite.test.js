// Comité de pilotage : établissements, médecins chefs et indicateurs consolidés (base en mémoire,
// données fictives). Lancer : npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');

let serveurMongo;
let api;
let http;
let mongoose;
const jetons = {};
const MDP_COMITE = 'Comite#Pilotage2026';

async function appel(qui, methode, chemin, corps) {
  const r = await fetch(`${api}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', ...(jetons[qui] ? { Authorization: `Bearer ${jetons[qui]}` } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  return { status: r.status, corps: r.status === 204 ? null : await r.json() };
}

/** Formulaire multipart, comme l'interface du comité. */
async function formulaire(qui, chemin, champs) {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  const r = await fetch(`${api}${chemin}`, { method: 'POST', headers: { Authorization: `Bearer ${jetons[qui]}` }, body: f });
  return { status: r.status, corps: await r.json() };
}

const etablissement = (nom) => ({
  nom, type: 'Centre de santé', secteur: 'Public', province: 'Kinshasa', zoneSante: 'ZS Fictive',
  adresse: 'Avenue fictive', telephone: '+243 000', responsable: 'Fictif', services: ['CPN', 'Maternité'],
});
const chef = (email, prenom = 'Clarisse') => ({
  prenom, nom: 'CHEF', postnom: 'TEST', sexe: 'F', dateNaissance: '1980-05-01', lieuNaissance: 'Kinshasa',
  nationalite: 'Congolaise', pieceType: 'Passeport', adresse: 'Fictive', telephone: '+243 81 000 0000',
  grade: 'Médecin spécialiste', specialite: 'Gynécologie-obstétrique', email,
});

async function connexionSoignant(email, motDePasse) {
  const r = await fetch(`${api}/auth/connexion`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, motDePasse }),
  });
  return { status: r.status, corps: await r.json() };
}

before(async () => {
  serveurMongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = serveurMongo.getUri('ami_connecte_essai');
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  const app = require('../app');
  mongoose = require('mongoose');
  await mongoose.connection.asPromise();
  assert.equal(mongoose.connection.name, 'ami_connecte_essai');

  const bcrypt = require('bcrypt');
  const MembreComite = require('../models/MembreComite');
  await MembreComite.create({ prenom: 'Paul', nom: 'PILOTE', email: 'comite@essai.test', motDePasse: await bcrypt.hash(MDP_COMITE, 4) });

  http = app.listen(0);
  await new Promise((r) => http.once('listening', r));
  api = `http://127.0.0.1:${http.address().port}/api`;
});

after(async () => {
  http?.close();
  await mongoose?.disconnect();
  await serveurMongo?.stop();
});

test('connexion du comité : jeton propre, refusé sur les routes du personnel', async () => {
  assert.equal((await appel(null, 'POST', '/comite/connexion', { email: 'comite@essai.test', motDePasse: 'faux' })).status, 401);
  const r = await appel(null, 'POST', '/comite/connexion', { email: 'COMITE@essai.test', motDePasse: MDP_COMITE });
  assert.equal(r.status, 200);
  assert.ok(r.corps.jeton);
  assert.equal(r.corps.membre.email, 'comite@essai.test');
  assert.ok(!('motDePasse' in r.corps.membre));
  jetons.comite = r.corps.jeton;
  assert.equal((await appel('comite', 'GET', '/patientes')).status, 403, 'aucun accès aux dossiers des patientes');
  assert.equal((await appel('comite', 'GET', '/soignants')).status, 403);
  assert.equal((await appel(null, 'GET', '/comite/etablissements')).status, 401);
});

test('le comité enregistre un établissement et son médecin chef ; le médecin chef se connecte à cet établissement', async () => {
  const r = await formulaire('comite', '/comite/etablissements', { ...etablissement('Centre Alpha'), medecinChef: chef('chef.alpha@essai.test') });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  assert.match(r.corps.etablissement.code, /^ETS-KIN-\d{4}$/);
  assert.equal(r.corps.medecinChef.email, 'chef.alpha@essai.test');
  assert.match(r.corps.medecinChef.matricule, /^MED-/);
  assert.ok(r.corps.motDePasseTemporaire, 'mot de passe temporaire renvoyé une fois');

  const c = await connexionSoignant('chef.alpha@essai.test', r.corps.motDePasseTemporaire);
  assert.equal(c.status, 200, JSON.stringify(c.corps));
  assert.equal(c.corps.etablissement.nom, 'Centre Alpha');
  assert.equal(c.corps.soignant.role, 'Médecin chef de service');
  assert.equal(c.corps.soignant.doitChangerMotDePasse, true);
  assert.equal(c.corps.soignant.ajoutePar.role, 'Comité de pilotage');
  jetons.chefAlpha = c.corps.jeton;
  jetons.etabAlpha = r.corps.etablissement.id;

  const liste = await appel('comite', 'GET', '/comite/etablissements');
  const alpha = liste.corps.find((e) => e.nom === 'Centre Alpha');
  assert.equal(alpha.medecinsChefs.length, 1);
  assert.equal(alpha.effectifs.soignants, 1);
});

test('établissement non créé si le médecin chef est invalide (rien n’est gardé)', async () => {
  const sansEmail = await formulaire('comite', '/comite/etablissements', { ...etablissement('Centre Bêta'), medecinChef: { ...chef(''), email: '' } });
  assert.equal(sansEmail.status, 400);
  const emailPris = await formulaire('comite', '/comite/etablissements', { ...etablissement('Centre Bêta'), medecinChef: chef('chef.alpha@essai.test') });
  assert.equal(emailPris.status, 409);
  const sansChef = await formulaire('comite', '/comite/etablissements', etablissement('Centre Bêta'));
  assert.equal(sansChef.status, 400);
  const Etablissement = require('../models/Etablissement');
  assert.equal(await Etablissement.exists({ nom: 'Centre Bêta' }), null);
});

test('le personnel ne peut plus créer, modifier ni supprimer d’établissement ; il garde la liste', async () => {
  assert.equal((await appel('chefAlpha', 'GET', '/etablissements')).status, 200);
  assert.equal((await appel('chefAlpha', 'POST', '/etablissements', etablissement('Centre Pirate'))).status, 404);
  assert.equal((await appel('chefAlpha', 'PATCH', `/etablissements/${jetons.etabAlpha}/statut`)).status, 404);
  assert.equal((await appel('chefAlpha', 'DELETE', `/etablissements/${jetons.etabAlpha}`)).status, 404);
  assert.equal((await appel('chefAlpha', 'POST', '/comite/etablissements', etablissement('Centre Pirate'))).status, 403, 'jeton soignant refusé côté comité');
});

test('le médecin chef ajoute son personnel dans son établissement seulement, et ne nomme pas de médecin chef', async () => {
  const Etablissement = require('../models/Etablissement');
  const autre = await Etablissement.create({ ...etablissement('Centre Gamma'), code: 'ETS-KIN-9999' });
  const nouveau = (role, affectations, email) => {
    const f = new FormData();
    const d = { ...chef(email, 'Prisca'), role, motDePasse: 'Soignant#2026x', affectations: JSON.stringify(affectations) };
    for (const [k, v] of Object.entries(d)) f.append(k, v);
    f.append('photo', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'photo.png');
    return fetch(`${api}/soignants`, { method: 'POST', headers: { Authorization: `Bearer ${jetons.chefAlpha}` }, body: f })
      .then(async (r) => ({ status: r.status, corps: await r.json() }));
  };
  const ailleurs = await nouveau('Sage-femme', [{ etablissementId: autre.id }], 'sf.ailleurs@essai.test');
  assert.equal(ailleurs.status, 403, JSON.stringify(ailleurs.corps));
  const autreChef = await nouveau('Médecin chef de service', [{ etablissementId: jetons.etabAlpha }], 'chef2@essai.test');
  assert.equal(autreChef.status, 403);
});

test('désignation d’un médecin chef pour un établissement qui n’en a pas ; refusée s’il en a déjà un', async () => {
  const Etablissement = require('../models/Etablissement');
  const ancien = await Etablissement.create({ ...etablissement('Centre Delta'), code: 'ETS-KIN-9998' });
  const r = await appel('comite', 'POST', `/comite/etablissements/${ancien.id}/medecin-chef`, { medecinChef: chef('chef.delta@essai.test') });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  assert.ok(r.corps.motDePasseTemporaire);
  const encore = await appel('comite', 'POST', `/comite/etablissements/${ancien.id}/medecin-chef`, { medecinChef: chef('chef.delta2@essai.test') });
  assert.equal(encore.status, 409);

  // Suspension puis nouveau mot de passe temporaire, depuis l'espace du comité.
  const suspendu = await appel('comite', 'PATCH', `/comite/etablissements/${ancien.id}/medecin-chef/${r.corps.medecinChef.id}/statut`);
  assert.equal(suspendu.corps.statut, 'Suspendu');
  const mdp = await appel('comite', 'POST', `/comite/etablissements/${ancien.id}/medecin-chef/${r.corps.medecinChef.id}/mot-de-passe`);
  assert.equal(mdp.status, 200);
  assert.ok(mdp.corps.motDePasseTemporaire);
});

test('indicateurs consolidés : tous les établissements, sans données nominatives', async () => {
  const Patiente = require('../models/Patiente');
  const Etablissement = require('../models/Etablissement');
  const gamma = await Etablissement.findOne({ nom: 'Centre Gamma' });
  const auteur = { id: '64b000000000000000000001', nom: 'Fictif', role: 'Médecin' };
  await Patiente.create({ numero: 'AC-PAT-880001', nom: 'Une', prenom: 'Alpha', telephone: '0810000001', etablissementId: jetons.etabAlpha, creePar: auteur });
  await Patiente.create({ numero: 'AC-PAT-880002', nom: 'Deux', prenom: 'Gamma', telephone: '0810000002', etablissementId: gamma.id, creePar: auteur });

  const p = await appel('comite', 'GET', '/comite/statistiques/patientes');
  assert.equal(p.status, 200, JSON.stringify(p.corps));
  assert.equal(p.corps.totaux.patientes, 2, 'patientes des deux établissements');
  assert.deepEqual(p.corps.recentes, [], 'aucune patiente nommée');
  assert.deepEqual(p.corps.prochainsRdv, []);
  const texte = JSON.stringify(p.corps);
  assert.ok(!texte.includes('AC-PAT-88') && !texte.includes('0810000001'), 'ni numéro ni téléphone');

  // Le médecin chef ne voit que son établissement.
  const chefStats = await appel('chefAlpha', 'GET', '/statistiques/patientes');
  assert.equal(chefStats.corps.totaux.patientes, 1);

  const s = await appel('comite', 'GET', '/comite/statistiques/synthese');
  assert.equal(s.status, 200, JSON.stringify(s.corps));
  assert.deepEqual(s.corps.aTraiter.lignes, []);
  assert.ok(!JSON.stringify(s.corps).includes('"lien"'), 'aucun lien vers les pages du personnel');

  const m = await appel('comite', 'GET', '/comite/statistiques/cpn-mensuel');
  assert.equal(m.status, 200);
  assert.ok(m.corps.lignes.length > 0, 'les lignes agrégées des analyses mensuelles restent');

  const t = await appel('comite', 'GET', '/comite/statistiques/etablissements');
  assert.equal(t.status, 200);
  assert.equal(t.corps.totaux.patientes, 2);
  assert.equal(t.corps.etablissements.find((e) => e.nom === 'Centre Alpha').patientes, 1);
  assert.equal(t.corps.etablissements.find((e) => e.nom === 'Centre Gamma').medecinChef, false);
});

test('suppression : refusée avec des patientes ; sinon l’établissement part avec son médecin chef', async () => {
  assert.equal((await appel('comite', 'DELETE', `/comite/etablissements/${jetons.etabAlpha}`)).status, 409);
  const r = await formulaire('comite', '/comite/etablissements', { ...etablissement('Centre Epsilon'), medecinChef: chef('chef.eps@essai.test') });
  assert.equal(r.status, 201);
  assert.equal((await appel('comite', 'DELETE', `/comite/etablissements/${r.corps.etablissement.id}`)).status, 204);
  const Soignant = require('../models/Soignant');
  assert.equal(await Soignant.exists({ email: 'chef.eps@essai.test' }), null);
});

test('le comité voit tout le personnel de la plateforme et ses établissements d’affectation (lecture seule)', async () => {
  const r = await appel('comite', 'GET', '/comite/soignants');
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  const delta = r.corps.find((s) => s.email === 'chef.delta@essai.test');
  assert.ok(delta, 'médecin chef d’un autre établissement visible');
  assert.equal(delta.affectations[0].nom, 'Centre Delta');
  assert.match(delta.affectations[0].code, /^ETS-KIN-/);
  assert.ok(r.corps.some((s) => s.email === 'chef.alpha@essai.test'));
  for (const champ of ['motDePasse', 'pieceNumero', 'dateNaissance', 'adresse']) assert.ok(!(champ in delta), `${champ} non exposé`);
  assert.equal((await appel('chefAlpha', 'GET', '/comite/soignants')).status, 403, 'jeton soignant refusé');
  assert.equal((await appel('comite', 'POST', '/comite/soignants', {})).status, 404, 'aucune création depuis le comité');
});

test('un membre complète son profil ; il ajoute un autre membre, qui se connecte avec le mot de passe temporaire', async () => {
  const p = await appel('comite', 'PATCH', '/comite/moi', { fonction: 'Président', organisation: 'Ministère de la Santé', telephone: '+243 81 000 1111', sexe: 'M', email: 'pirate@essai.test' });
  assert.equal(p.status, 200, JSON.stringify(p.corps));
  assert.equal(p.corps.organisation, 'Ministère de la Santé');
  assert.equal(p.corps.email, 'comite@essai.test', 'l’e-mail ne se change pas depuis le profil');
  assert.ok(!('photoCle' in p.corps) && !('motDePasse' in p.corps));

  assert.equal((await appel('comite', 'POST', '/comite/membres', { prenom: 'Sans', nom: 'Email' })).status, 400);
  const n = await appel('comite', 'POST', '/comite/membres', { prenom: 'Aline', nom: 'Bisimwa', email: 'Aline@Essai.test', fonction: 'Secrétaire' });
  assert.equal(n.status, 201, JSON.stringify(n.corps));
  assert.equal(n.corps.membre.email, 'aline@essai.test');
  assert.equal(n.corps.membre.ajoutePar.nom, 'Paul PILOTE');
  assert.ok(n.corps.motDePasseTemporaire);
  assert.equal((await appel('comite', 'POST', '/comite/membres', { prenom: 'X', nom: 'Y', email: 'aline@essai.test' })).status, 409);

  const c = await appel(null, 'POST', '/comite/connexion', { email: 'aline@essai.test', motDePasse: n.corps.motDePasseTemporaire });
  assert.equal(c.status, 200);
  assert.equal(c.corps.membre.doitChangerMotDePasse, true);
  const liste = await appel('comite', 'GET', '/comite/membres');
  assert.deepEqual(liste.corps.map((m) => m.email).sort(), ['aline@essai.test', 'comite@essai.test']);
  assert.equal((await appel('chefAlpha', 'GET', '/comite/membres')).status, 403);
});

test('le comité voit tous les RECO de la plateforme, avec leur structure (lecture seule)', async () => {
  const Reco = require('../models/Reco');
  const Etablissement = require('../models/Etablissement');
  const gamma = await Etablissement.findOne({ nom: 'Centre Gamma' });
  const auteur = { id: '64b000000000000000000001', nom: 'Clarisse CHEF', role: 'Médecin chef de service' };
  await Reco.create({ matricule: 'RECO-100001', prenom: 'Jean', nom: 'Mpiana', sexe: 'M', telephone: '+243 81 000 2222', etablissementId: jetons.etabAlpha, zones: ['Kilimani'], motDePasse: 'x', creePar: auteur });
  await Reco.create({ matricule: 'RECO-100002', prenom: 'Odette', nom: 'Lusamba', sexe: 'F', telephone: '+243 81 000 3333', etablissementId: gamma.id, motDePasse: 'x', creePar: auteur, statut: 'Suspendu' });
  const r = await appel('comite', 'GET', '/comite/recos');
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.equal(r.corps.length, 2, 'RECO de tous les établissements');
  const jean = r.corps.find((x) => x.matricule === 'RECO-100001');
  assert.equal(jean.etablissement.nom, 'Centre Alpha');
  assert.deepEqual(jean.zones, ['Kilimani']);
  assert.equal(jean.taches.ouvertes, 0);
  assert.ok(!('motDePasse' in jean));
  assert.equal((await appel('chefAlpha', 'GET', '/comite/recos')).status, 403);
  assert.equal((await appel('comite', 'POST', '/comite/recos', {})).status, 404, 'aucune création depuis le comité');
});
