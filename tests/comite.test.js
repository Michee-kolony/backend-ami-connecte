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
  nom, type: 'Centre de santé', secteur: 'Public', province: 'Kinshasa', zonesSante: ['Lemba', 'Limete'],
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
  assert.deepEqual(r.corps.etablissement.zonesSante, ['Lemba', 'Limete']);
  assert.equal(r.corps.etablissement.zoneSante, 'Lemba', 'zone principale = première sélectionnée');
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

test('zones de santé : au moins une, toutes de la province choisie', async () => {
  const sansZone = await formulaire('comite', '/comite/etablissements', { ...etablissement('Centre Zêta'), zonesSante: [], medecinChef: chef('chef.zeta@essai.test') });
  assert.equal(sansZone.status, 400);
  assert.match(sansZone.corps.message, /au moins une zone/);
  const horsProvince = await formulaire('comite', '/comite/etablissements', { ...etablissement('Centre Zêta'), zonesSante: ['Lemba', 'Goma'], medecinChef: chef('chef.zeta@essai.test') });
  assert.equal(horsProvince.status, 400);
  assert.match(horsProvince.corps.message, /Goma/);
  const Etablissement = require('../models/Etablissement');
  assert.equal(await Etablissement.exists({ nom: 'Centre Zêta' }), null);
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

test('seul le président du comité retire un membre ; il ne peut pas se retirer lui-même', async () => {
  const MembreComite = require('../models/MembreComite');
  const aline = await MembreComite.findOne({ email: 'aline@essai.test' });
  // Paul n'est pas président : refus.
  assert.equal((await appel('comite', 'DELETE', `/comite/membres/${aline.id}`)).status, 403);
  await MembreComite.updateOne({ email: 'comite@essai.test' }, { estPresident: true });
  const moi = await appel('comite', 'GET', '/comite/moi');
  assert.equal(moi.corps.estPresident, true);
  assert.equal((await appel('comite', 'DELETE', `/comite/membres/${moi.corps.id}`)).status, 400, 'pas de retrait de soi-même');
  assert.equal((await appel('comite', 'DELETE', '/comite/membres/64b000000000000000000009')).status, 404);
  // L'ancien membre ne peut plus se connecter une fois retiré.
  assert.equal((await appel('comite', 'DELETE', `/comite/membres/${aline.id}`)).status, 204);
  assert.equal(await MembreComite.exists({ email: 'aline@essai.test' }), null);
  // Un membre ne se nomme pas président depuis son profil.
  await MembreComite.updateOne({ email: 'comite@essai.test' }, { estPresident: false });
  const p = await appel('comite', 'PATCH', '/comite/moi', { estPresident: 'true' });
  assert.equal(p.corps.estPresident, false);
});

test('le médecin chef rattache un soignant à plusieurs établissements, dont au moins le sien ; le soignant choisit à la connexion', async () => {
  const bcrypt = require('bcrypt');
  const Soignant = require('../models/Soignant');
  const Etablissement = require('../models/Etablissement');
  const gamma = await Etablissement.findOne({ nom: 'Centre Gamma' });
  const motDePasse = 'Infirmier#2026x';
  const inf = await Soignant.create({
    matricule: 'INF-7701', prenom: 'Nadine', nom: 'KABEYA', sexe: 'F', dateNaissance: '1990-01-01', lieuNaissance: 'Kinshasa',
    nationalite: 'Congolaise', pieceType: 'Passeport', adresse: 'Fictive', telephone: '000', grade: 'Gradué(e) (A1)',
    specialite: 'Soins infirmiers généraux', role: 'Infirmier(ère)', email: 'nadine@essai.test', motDePasse: await bcrypt.hash(motDePasse, 4),
    affectations: [{ etablissementId: jetons.etabAlpha }], doitChangerMotDePasse: false,
  });
  // Ajout d'un second établissement (pas celui du médecin chef) : accepté.
  const r = await appel('chefAlpha', 'PATCH', `/soignants/${inf.id}`, { affectations: [{ etablissementId: jetons.etabAlpha, service: 'CPN' }, { etablissementId: gamma.id, service: 'Urgences' }] });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.deepEqual(r.corps.affectations.map((a) => a.etablissementId), [jetons.etabAlpha, gamma.id]);
  // Retirer l'établissement du médecin chef (ne garder qu'un autre) : refusé.
  assert.equal((await appel('chefAlpha', 'PATCH', `/soignants/${inf.id}`, { affectations: [{ etablissementId: gamma.id }] })).status, 403);
  // À la connexion, la soignante choisit l'établissement où elle travaille.
  const c1 = await fetch(`${api}/auth/connexion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nadine@essai.test', motDePasse }) }).then((x) => x.json());
  assert.equal(c1.choixEtablissement, true);
  assert.deepEqual(c1.etablissements.map((e) => e.nom).sort(), ['Centre Alpha', 'Centre Gamma']);
  const c2 = await fetch(`${api}/auth/connexion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nadine@essai.test', motDePasse, etablissementId: gamma.id }) }).then((x) => x.json());
  assert.equal(c2.etablissement.nom, 'Centre Gamma');
});

test('le comité voit toutes les ambulances et tous les chauffeurs, avec leur établissement (lecture seule)', async () => {
  const Ambulance = require('../models/Ambulance');
  const Chauffeur = require('../models/Chauffeur');
  const Etablissement = require('../models/Etablissement');
  const gamma = await Etablissement.findOne({ nom: 'Centre Gamma' });
  const auteur = { id: '64b000000000000000000001', nom: 'Clarisse CHEF', role: 'Médecin chef de service' };
  const chf = await Chauffeur.create({ matricule: 'CHF-100001', prenom: 'Didier', nom: 'Mbala', telephone: '+243 81 000 4444', etablissementId: jetons.etabAlpha, motDePasse: 'x', creePar: auteur });
  await Ambulance.create({ code: 'AMB-01', immatriculation: 'kin-1234', modele: 'Toyota Land Cruiser', type: 'Type B — soins d’urgence', etablissementId: jetons.etabAlpha, chauffeurId: chf._id, creePar: auteur });
  await Ambulance.create({ code: 'AMB-02', immatriculation: 'KIN-5678', modele: 'Nissan Patrol', type: 'Type A — transport', etablissementId: gamma.id, statut: 'Maintenance', creePar: auteur, position: { lat: -4.3, lng: 15.3, le: new Date() } });
  const r = await appel('comite', 'GET', '/comite/flotte');
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.equal(r.corps.ambulances.length, 2, 'ambulances de tous les établissements');
  const amb1 = r.corps.ambulances.find((a) => a.code === 'AMB-01');
  assert.equal(amb1.etablissement.nom, 'Centre Alpha');
  assert.equal(amb1.chauffeur.nom, 'Didier MBALA');
  assert.ok(!('position' in r.corps.ambulances.find((a) => a.code === 'AMB-02')), 'pas de position GPS');
  const didier = r.corps.chauffeurs.find((c) => c.matricule === 'CHF-100001');
  assert.equal(didier.ambulance.code, 'AMB-01');
  assert.equal(didier.etablissement.nom, 'Centre Alpha');
  assert.ok(!('motDePasse' in didier));
  assert.equal((await appel('chefAlpha', 'GET', '/comite/flotte')).status, 403);
});

test('messagerie : le médecin chef discute avec un membre du comité ; un simple soignant ne peut pas', async () => {
  const MembreComite = require('../models/MembreComite');
  const paul = await MembreComite.findOne({ email: 'comite@essai.test' });
  // Annuaire du médecin chef : le comité y figure.
  const annuaire = await appel('chefAlpha', 'GET', '/discussions/annuaire');
  assert.ok(annuaire.corps.some((x) => x.id === paul.id && x.role === 'Comité de pilotage'));
  // Ouverture par le médecin chef, puis message.
  const d = await appel('chefAlpha', 'POST', '/discussions', { membreComiteId: paul.id });
  assert.equal(d.status, 201, JSON.stringify(d.corps));
  assert.equal(d.corps.interlocuteur.role, 'Comité de pilotage');
  const m = await appel('chefAlpha', 'POST', `/discussions/${d.corps.id}/messages`, { texte: 'Bonjour au comité' });
  assert.equal(m.status, 201);
  // Le comité retrouve la discussion, lit et répond.
  const liste = await appel('comite', 'GET', '/comite/discussions');
  const vue = liste.corps.find((x) => x.id === d.corps.id);
  assert.ok(vue, 'discussion visible côté comité');
  assert.equal(vue.interlocuteur.prenom, 'Clarisse');
  assert.equal(vue.nonLus, 1);
  const hist = await appel('comite', 'GET', `/comite/discussions/${d.corps.id}/messages`);
  assert.equal(hist.corps.messages[0].texte, 'Bonjour au comité');
  assert.equal((await appel('comite', 'POST', `/comite/discussions/${d.corps.id}/messages`, { texte: 'Bien reçu' })).status, 201);
  assert.equal((await appel('comite', 'POST', `/comite/discussions/${d.corps.id}/lu`)).status, 200);
  // Annuaire du comité : les médecins chefs actifs.
  const chefs = await appel('comite', 'GET', '/comite/discussions/annuaire');
  assert.ok(chefs.corps.some((c) => c.prenom === 'Clarisse' && c.etablissement === 'Centre Alpha'));
  // Le comité ne lit pas une discussion entre soignants.
  const Discussion = require('../models/Discussion');
  const autre = await Discussion.create({ participants: ['64b000000000000000000011', '64b000000000000000000012'], cle: 'x:y' });
  assert.equal((await appel('comite', 'GET', `/comite/discussions/${autre.id}/messages`)).status, 404);
  // Un soignant qui n'est pas médecin chef ne peut pas ouvrir de discussion avec le comité.
  const Soignant = require('../models/Soignant');
  const jwt = require('jsonwebtoken');
  const nadine = await Soignant.findOne({ email: 'nadine@essai.test' });
  jetons.nadine = jwt.sign({ sub: nadine.id, role: nadine.role, etablissement: jetons.etabAlpha }, process.env.JWT_SECRET, { expiresIn: '10m' });
  assert.equal((await appel('nadine', 'POST', '/discussions', { membreComiteId: paul.id })).status, 403);
  assert.ok(!(await appel('nadine', 'GET', '/discussions/annuaire')).corps.some((x) => x.role === 'Comité de pilotage'));
});

test('groupe de pilotage : médecins chefs et comité échangent ; les autres soignants n’y ont pas accès', async () => {
  const g = await appel('comite', 'GET', '/comite/groupe-pilotage');
  assert.equal(g.status, 200);
  assert.ok(g.corps.membres.some((m) => m.type === 'comite') && g.corps.membres.some((m) => m.type === 'soignant'));
  assert.equal((await appel('comite', 'POST', '/comite/groupe-pilotage/messages', { texte: 'Réunion lundi 9 h' })).status, 201);
  const vuChef = await appel('chefAlpha', 'GET', '/discussions/groupe-pilotage');
  assert.equal(vuChef.status, 200);
  assert.equal(vuChef.corps.nonLus, 1);
  assert.equal(vuChef.corps.dernierMessage.texte, 'Réunion lundi 9 h');
  assert.equal((await appel('chefAlpha', 'POST', '/discussions/groupe-pilotage/messages', { texte: 'Présent' })).status, 201);
  const hist = await appel('comite', 'GET', '/comite/groupe-pilotage/messages');
  assert.deepEqual(hist.corps.messages.map((m) => m.texte), ['Réunion lundi 9 h', 'Présent']);
  assert.equal(hist.corps.messages[1].auteurType, 'soignant');
  assert.equal((await appel('chefAlpha', 'POST', '/discussions/groupe-pilotage/lu')).status, 200);
  assert.equal((await appel('chefAlpha', 'GET', '/discussions/groupe-pilotage')).corps.nonLus, 0);
  assert.equal((await appel('nadine', 'GET', '/discussions/groupe-pilotage')).status, 403);
  assert.equal((await appel('nadine', 'POST', '/discussions/groupe-pilotage/messages', { texte: 'x' })).status, 403);
  const MessageGroupe = require('../models/MessageGroupe');
  const brut = await MessageGroupe.findOne({}).lean();
  assert.ok(!JSON.stringify(brut).includes('Réunion'), 'texte chiffré au repos');
});

test('patientes : le comité voit l’identité et les enfants de toutes les patientes, sans données médicales', async () => {
  const Patiente = require('../models/Patiente');
  const Enfant = require('../models/Enfant');
  const alpha = await Patiente.findOne({ numero: 'AC-PAT-880001' });
  await Patiente.updateOne({ _id: alpha._id }, { dateNaissance: '1995-03-10', telephone: '0810000001', adresse: { province: 'Kinshasa', commune: 'Ngaliema', quartier: 'Kintambo' } });
  await Enfant.collection.insertOne({ numero: 'AC-ENF-990001', mereId: alpha._id, prenom: 'Petit', nom: 'UNE', postnom: '', sexe: 'Masculin', dateNaissance: '2026-01-15', etablissementId: jetons.etabAlpha, vaccinations: [], statut: 'Suivi', createdAt: new Date() });
  const r = await appel('comite', 'GET', '/comite/patientes');
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.equal(r.corps.total, 2, 'patientes de tous les établissements');
  const p = r.corps.patientes.find((x) => x.numero === 'AC-PAT-880001');
  assert.ok(p.age >= 30);
  assert.equal(p.residence.commune, 'Ngaliema');
  assert.equal(p.etablissement.nom, 'Centre Alpha');
  assert.equal(p.enfants.length, 1);
  assert.equal(p.enfants[0].prenom, 'Petit');
  const texte = JSON.stringify(r.corps);
  for (const interdit of ['0810000001', 'telephone', 'statut', 'grossesse', 'vaccinations', 'groupeSanguin']) {
    assert.ok(!texte.includes(interdit), `${interdit} non exposé`);
  }
  // Recherche par prénom d'enfant : on retrouve la mère.
  const re = await appel('comite', 'GET', '/comite/patientes?q=Petit');
  assert.deepEqual(re.corps.patientes.map((x) => x.numero), ['AC-PAT-880001']);
  // Consultation journalisée.
  const JournalAudit = require('../models/JournalAudit');
  assert.ok(await JournalAudit.exists({ action: 'comite.patientes.consultation', 'acteur.role': 'Comité de pilotage' }));
  assert.equal((await appel('chefAlpha', 'GET', '/comite/patientes')).status, 403);
});
