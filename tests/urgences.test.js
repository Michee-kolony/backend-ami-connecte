// Tests des urgences : alerte de la patiente → prise en charge → chauffeur et ambulance envoyés
// → course suivie (statuts, position GPS en temps réel) → clôture ; flotte et application chauffeur.
// Base MongoDB en mémoire, données fictives : aucune donnée réelle n'est lue ni écrite.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Server } = require('socket.io');
const { io: client } = require('socket.io-client');

let serveurMongo;
let api;
let origine;
let http;
let mongoose;
const jetons = {};
const sockets = [];
let idMedecin;
let idInfirmiere;

async function appel(qui, methode, chemin, corps) {
  const jeton = jetons[qui] ?? qui;
  const r = await fetch(`${api}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  return { status: r.status, corps: texte ? JSON.parse(texte) : null };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function creerChauffeur(qui, donnees, { photo = true } = {}) {
  const f = new FormData();
  f.append('donnees', JSON.stringify(donnees));
  if (photo) f.append('photo', new Blob([PNG], { type: 'image/png' }), 'chauffeur.png');
  const r = await fetch(`${api}/flotte/chauffeurs`, { method: 'POST', headers: { Authorization: `Bearer ${jetons[qui]}` }, body: f });
  return { status: r.status, corps: await r.json() };
}

function connecter(jeton) {
  const s = client(origine, { auth: { jeton }, transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

const attendre = (s, evenement) => new Promise((resolve) => s.once(evenement, resolve));

before(async () => {
  serveurMongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = serveurMongo.getUri('ami_connecte_essai_urgences');
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  const r2 = require('../config/r2');
  r2.envoyerFichier = async (fichier, dossier) => ({ cle: `${dossier}/essai.png`, url: `https://public.invalid/${dossier}/essai.png` });
  r2.supprimerFichier = async () => {};
  r2.urlSignee = async (cle) => (cle ? `https://signe.invalid/${cle}` : null);
  const app = require('../app');
  const presence = require('../config/presence');
  mongoose = require('mongoose');
  await mongoose.connection.asPromise();

  const Soignant = require('../models/Soignant');
  const Patiente = require('../models/Patiente');
  const jwt = require('jsonwebtoken');
  const base = {
    postnom: 'TEST', sexe: 'F', dateNaissance: '1985-01-01', lieuNaissance: 'Kinshasa', nationalite: 'Congolaise',
    pieceType: 'Passeport', adresse: 'Fictive', telephone: '000', grade: 'Fictif', specialite: 'Fictive', motDePasse: 'x',
    affectations: [{ etablissementId: 'ETAB' }],
  };
  const medecin = await Soignant.create({ ...base, prenom: 'Marie', nom: 'REGULATRICE', role: 'Médecin', matricule: 'MED-9301', email: 'med@urgences.test' });
  const infirmiere = await Soignant.create({ ...base, prenom: 'Inès', nom: 'INF', role: 'Infirmier(ère)', matricule: 'INF-9301', email: 'inf@urgences.test' });
  jetons.medecin = jwt.sign({ sub: medecin.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  idMedecin = medecin.id;
  idInfirmiere = infirmiere.id;
  jetons.infirmiere = jwt.sign({ sub: infirmiere.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const auteur = { id: medecin.id, nom: 'Marie REGULATRICE', role: 'Médecin' };
  const patiente = await Patiente.create({
    numero: 'AC-PAT-993001', nom: 'Tshibanda', prenom: 'Marie', telephone: '+243 82 000 0000', espaceEnLigne: 'Activé',
    adresse: { commune: 'Ngaliema', quartier: 'Binza Pigeon' }, creePar: auteur,
  });
  jetons.patiente = jwt.sign({ sub: patiente.id, typ: 'patiente' }, process.env.JWT_SECRET, { expiresIn: '10m' });

  http = app.listen(0);
  presence.initialiser(new Server(http));
  await new Promise((r) => http.once('listening', r));
  origine = `http://127.0.0.1:${http.address().port}`;
  api = `${origine}/api`;
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  http?.close();
  await mongoose?.disconnect();
  await serveurMongo?.stop();
});

let chauffeur;
let motDePasseChauffeur = 'Volant@2026x';

test('flotte : ambulances et compte chauffeur (photo et mot de passe obligatoires, matricule CHF-0001)', async () => {
  const a1 = await appel('medecin', 'POST', '/flotte/ambulances', { immatriculation: 'gr-4521-kn', modele: 'Toyota Land Cruiser', type: 'Type B — soins d’urgence', annee: 2022 });
  assert.equal(a1.status, 201, JSON.stringify(a1.corps));
  assert.deepEqual([a1.corps.code, a1.corps.immatriculation, a1.corps.statut], ['AMB-01', 'GR-4521-KN', 'Disponible']);
  assert.equal((await appel('medecin', 'POST', '/flotte/ambulances', { immatriculation: 'GR-4521-KN', modele: 'X', type: 'Type A — transport' })).status, 409);
  assert.equal((await appel('infirmiere', 'POST', '/flotte/ambulances', { immatriculation: 'GR-1', modele: 'X', type: 'Type A — transport' })).status, 403, 'flotte gérée par les médecins');
  await appel('medecin', 'POST', '/flotte/ambulances', { immatriculation: 'GR-3307-KN', modele: 'Toyota HiAce', type: 'Type A — transport' });

  assert.equal((await creerChauffeur('medecin', { prenom: 'Bienvenu', nom: 'Lema', telephone: '+243 81 556 2201', motDePasse: motDePasseChauffeur }, { photo: false })).status, 400, 'photo obligatoire');
  assert.equal((await creerChauffeur('medecin', { prenom: 'Bienvenu', nom: 'Lema', telephone: '+243 81', motDePasse: 'faible' })).status, 400);
  const c = await creerChauffeur('medecin', { prenom: 'Bienvenu', nom: 'Lema', postnom: 'Ndongala', telephone: '+243 81 556 2201', permis: 'kin-c-1', motDePasse: motDePasseChauffeur, ambulance: 'AMB-01' });
  assert.equal(c.status, 201, JSON.stringify(c.corps));
  chauffeur = c.corps;
  assert.deepEqual([chauffeur.matricule, chauffeur.nom, chauffeur.photo, chauffeur.ambulance.code, chauffeur.disponibilite], ['CHF-0001', 'LEMA', 'https://public.invalid/chauffeurs/essai.png', 'AMB-01', 'Disponible']);
  assert.equal(chauffeur.motDePasse, undefined);

  const carte = await appel('medecin', 'GET', `/flotte/chauffeurs/${chauffeur.id}/carte-service`);
  assert.equal(carte.status, 200);
  assert.match(carte.corps.qr, /^data:image\/png;base64,/);
});

test('application chauffeur : connexion par matricule, jeton refusé ailleurs', async () => {
  assert.equal((await appel(null, 'POST', '/chauffeur/connexion', { matricule: 'CHF-0001', motDePasse: 'faux' })).status, 401);
  const r = await appel(null, 'POST', '/chauffeur/connexion', { matricule: 'chf-0001', motDePasse: motDePasseChauffeur });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  jetons.chauffeur = r.corps.jeton;
  assert.deepEqual([r.corps.chauffeur.ambulance.code, r.corps.chauffeur.doitChangerMotDePasse], ['AMB-01', true]);
  assert.equal((await appel('chauffeur', 'GET', '/urgences')).status, 403, 'pas d’accès à la régulation');
  assert.equal((await appel('patiente', 'GET', '/chauffeur/moi')).status, 403);
  const changement = await appel('chauffeur', 'PUT', '/chauffeur/moi/mot-de-passe', { actuel: motDePasseChauffeur, nouveau: 'Nouveau#2026a' });
  assert.equal(changement.status, 200, JSON.stringify(changement.corps));
  assert.equal(changement.corps.doitChangerMotDePasse, false);
  motDePasseChauffeur = 'Nouveau#2026a';
  assert.deepEqual((await appel('chauffeur', 'GET', '/chauffeur/mission')).corps, { mission: null });
});

test('urgence : alerte de la patiente → régulation (son) → chauffeur et ambulance → course en temps réel → clôture', async () => {
  const personnel = await connecter(jetons.medecin);
  const tel = await connecter(jetons.patiente);
  const appli = await connecter(jetons.chauffeur);

  assert.equal((await appel('patiente', 'POST', '/espace-patiente/urgences', { motif: 'douleurs' })).status, 400, 'position GPS requise');
  const recue = attendre(personnel, 'urgence:nouvelle');
  const alerte = await appel('patiente', 'POST', '/espace-patiente/urgences', { motif: 'douleurs', lat: -4.3446, lng: 15.2612, precision: 12 });
  assert.equal(alerte.status, 201, JSON.stringify(alerte.corps));
  const numero = alerte.corps.id;
  assert.match(numero, /^URG-\d{6}$/);
  const diffusee = await recue;
  assert.deepEqual([diffusee.id, diffusee.motif, diffusee.gravite, diffusee.etat, diffusee.commune], [numero, 'Douleurs prénatales', 'élevée', 'nouvelle', 'Ngaliema']);
  const encore = await appel('patiente', 'POST', '/espace-patiente/urgences', { motif: 'autre', lat: -4.3, lng: 15.2 });
  assert.deepEqual([encore.status, encore.corps.id], [200, numero], 'une seule alerte active');

  const liste = await appel('infirmiere', 'GET', '/urgences');
  assert.deepEqual(liste.corps.map((x) => x.id), [numero]);
  const prise = await appel('infirmiere', 'POST', `/urgences/${numero}/prise-en-charge`);
  assert.equal(prise.corps.etat, 'prise en charge');

  // Ambulance en maintenance : refusée ; chauffeur et ambulance disponibles : envoyés.
  await appel('medecin', 'PATCH', '/flotte/ambulances/AMB-02', { statut: 'Maintenance' });
  assert.equal((await appel('infirmiere', 'POST', `/urgences/${numero}/affectation`, { chauffeurId: chauffeur.id, ambulance: 'AMB-02' })).status, 409);
  const profilRecharge = attendre(appli, 'profil:maj');
  await appel('medecin', 'PATCH', '/flotte/ambulances/AMB-01', { chauffeurId: chauffeur.id });
  await profilRecharge;
  const missionRecue = attendre(appli, 'mission:nouvelle');
  const suiviPatiente = attendre(tel, 'urgence:maj');
  assert.equal((await appel('infirmiere', 'POST', `/urgences/${numero}/affectation`, { chauffeurId: chauffeur.id, ambulance: 'AMB-01', infirmierId: idMedecin })).status, 400, 'un médecin n’est pas proposé comme infirmier');
  const envoi = await appel('infirmiere', 'POST', `/urgences/${numero}/affectation`, { chauffeurId: chauffeur.id, ambulance: 'AMB-01', infirmierId: idInfirmiere });
  assert.equal(envoi.status, 200, JSON.stringify(envoi.corps));
  assert.deepEqual(envoi.corps.infirmier, { id: idInfirmiere, nom: 'Inès INF', role: 'Infirmier(ère)', photo: null });
  assert.deepEqual([envoi.corps.ambulanceId, envoi.corps.chauffeur, envoi.corps.statutCourse], ['AMB-01', 'Bienvenu LEMA', 'Assignée']);
  const mission = await missionRecue;
  // Application rouverte : la mission confiée est rechargée par GET /chauffeur/mission.
  const rechargee = await appel('chauffeur', 'GET', '/chauffeur/mission');
  assert.deepEqual([rechargee.status, rechargee.corps.mission?.id, rechargee.corps.mission?.statutCourse], [200, numero, 'Assignée']);
  assert.deepEqual([mission.id, mission.patiente.prenom, mission.lat, mission.infirmier.nom], [numero, 'Marie', -4.3446, 'Inès INF']);
  assert.equal((await suiviPatiente).chauffeur.nom, 'LEMA');

  const ambulances = (await appel('medecin', 'GET', '/flotte/ambulances')).corps;
  assert.equal(ambulances.find((a) => a.code === 'AMB-01').statut, 'En mission', 'ambulance occupée');
  const chauffeurs = (await appel('medecin', 'GET', '/flotte/chauffeurs')).corps;
  assert.deepEqual([chauffeurs[0].disponibilite, chauffeurs[0].mission], ['Occupé', numero]);
  assert.equal((await appel('medecin', 'PATCH', `/flotte/chauffeurs/${chauffeur.id}/statut`, { statut: 'Suspendu' })).status, 409, 'pas de suspension en mission');

  // Position GPS envoyée chaque seconde par l'application : reçue par la régulation et la patiente.
  const positionRegulation = attendre(personnel, 'ambulance:position');
  const positionPatiente = attendre(tel, 'ambulance:position');
  appli.emit('position', { lat: -4.321, lng: 15.2745, cap: 90, vitesse: 42.37 });
  const p = await positionRegulation;
  assert.deepEqual([p.ambulance, p.urgence, p.lat, p.vitesse], ['AMB-01', numero, -4.321, 42.4]);
  assert.equal((await positionPatiente).ambulance, 'AMB-01');

  // Chat de l'urgence : patiente, chauffeur et régulation dans la même conversation, en temps réel.
  const recuParPatiente = attendre(tel, 'urgence:message');
  const recuParRegulation = attendre(personnel, 'urgence:message');
  const m1 = await appel('chauffeur', 'POST', `/chauffeur/missions/${numero}/messages`, { texte: 'Je suis à 5 minutes, restez au portail.' });
  assert.equal(m1.status, 201, JSON.stringify(m1.corps));
  assert.deepEqual([(await recuParPatiente).texte, (await recuParRegulation).auteur.type], ['Je suis à 5 minutes, restez au portail.', 'chauffeur']);
  const recuParChauffeur = attendre(appli, 'urgence:message');
  await appel('patiente', 'POST', `/espace-patiente/urgences/${numero}/messages`, { texte: 'D’accord, merci !' });
  assert.equal((await recuParChauffeur).auteur.nom, 'Marie TSHIBANDA');
  await appel('infirmiere', 'POST', `/urgences/${numero}/messages`, { texte: 'Maternité prévenue.' });
  assert.equal((await appel('patiente', 'POST', `/espace-patiente/urgences/${numero}/messages`, { texte: '  ' })).status, 400);
  const fil = await appel('patiente', 'GET', `/espace-patiente/urgences/${numero}/messages`);
  assert.deepEqual(fil.corps.map((m) => m.auteur.type), ['chauffeur', 'patiente', 'regulation']);
  const MessageUrgence = require('../models/MessageUrgence');
  assert.equal((await MessageUrgence.findOne()).contenu.d.includes('portail'), false, 'texte chiffré au repos');

  // Statuts de la course, dans l'ordre.
  const statut = (s) => appel('chauffeur', 'POST', `/chauffeur/missions/${numero}/statut`, { statut: s });
  assert.equal((await statut('Terminée')).status, 409, 'arrivée sur place d’abord');
  assert.equal((await statut('En route')).status, 200);
  assert.equal((await statut('Arrivée sur place')).status, 200);
  assert.equal((await statut('En route')).status, 409, 'pas de retour en arrière');
  assert.equal((await statut('Patiente à bord')).status, 200);
  assert.equal((await appel('patiente', 'POST', `/espace-patiente/urgences/${numero}/annulation`)).status, 409, 'à bord : plus d’annulation');
  assert.equal((await appel('infirmiere', 'POST', `/urgences/${numero}/affectation`, { chauffeurId: chauffeur.id, ambulance: 'AMB-01' })).status, 409);
  assert.equal((await statut('Arrivée à l’hôpital')).status, 200);
  const fin = await statut('Terminée');
  assert.deepEqual([fin.status, fin.corps.mission.etat, fin.corps.mission.statutCourse], [200, 'résolue', 'Terminée']);
  assert.deepEqual(fin.corps.mission.evenements.map((e) => e.type), [
    'Alerte reçue', 'Prise en charge', 'Ambulance envoyée', 'En route', 'Arrivée sur place', 'Patiente à bord', 'Arrivée à l’hôpital', 'Clôturée',
  ]);
  // Mission terminée : conversation supprimée définitivement, plus d'envoi possible.
  assert.equal(await MessageUrgence.countDocuments(), 0, 'messages supprimés de la base');
  assert.deepEqual((await appel('infirmiere', 'GET', `/urgences/${numero}/messages`)).corps, []);
  assert.equal((await appel('patiente', 'POST', `/espace-patiente/urgences/${numero}/messages`, { texte: 'Merci' })).status, 409);
  const libre = (await appel('medecin', 'GET', '/flotte/ambulances')).corps.find((a) => a.code === 'AMB-01');
  assert.deepEqual([libre.statut, libre.urgence], ['Disponible', null], 'ambulance libérée');
  assert.deepEqual((await appel('patiente', 'GET', '/espace-patiente/urgences/active')).corps, { urgence: null });
  assert.equal((await appel('chauffeur', 'GET', `/chauffeur/missions/URG-999999/messages`)).status, 404);
  const stats = (await appel('chauffeur', 'GET', '/chauffeur/statistiques')).corps;
  assert.deepEqual([stats.courses.total, stats.courses.aujourdhui, stats.patientesTransportees, stats.parGravite['élevée'], stats.septJours.length, stats.septJours[6].courses],
    [1, 1, 1, 1, 7, 1]);
});

test('urgence : annulation par la patiente avant le départ, fausse alerte annulée par la régulation', async () => {
  const a = await appel('patiente', 'POST', '/espace-patiente/urgences', { motif: 'saignements', lat: -4.33, lng: 15.3 });
  assert.equal(a.corps.gravite, 'critique');
  await appel('patiente', 'POST', `/espace-patiente/urgences/${a.corps.id}/messages`, { texte: 'Je me suis trompée' });
  const annulee = await appel('patiente', 'POST', `/espace-patiente/urgences/${a.corps.id}/annulation`);
  assert.equal(await require('../models/MessageUrgence').countDocuments(), 0, 'annulée : conversation supprimée');
  assert.equal(annulee.corps.etat, 'annulée');

  const b = await appel('patiente', 'POST', '/espace-patiente/urgences', { motif: 'autre', lat: -4.33, lng: 15.3 });
  assert.equal((await appel('medecin', 'POST', `/urgences/${b.corps.id}/annulation`, {})).status, 400, 'motif obligatoire');
  const fausse = await appel('medecin', 'POST', `/urgences/${b.corps.id}/annulation`, { motif: 'Appel de vérification : la patiente va bien' });
  assert.equal(fausse.corps.etat, 'annulée');
  const historique = await appel('medecin', 'GET', '/urgences?etat=toutes');
  assert.equal(historique.corps.length, 3);
});

test('hors connexion : une saisie renvoyée avec le même X-Operation-Id n’est enregistrée qu’une fois', async () => {
  const envoyer = () => fetch(`${api}/flotte/ambulances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jetons.medecin}`, 'X-Operation-Id': 'op-essai-0001-hors-ligne' },
    body: JSON.stringify({ immatriculation: 'GR-9999-KN', modele: 'Toyota HiAce', type: 'Type A — transport' }),
  });
  const premier = await envoyer();
  assert.equal(premier.status, 201);
  const corps = await premier.json();
  await new Promise((r) => setTimeout(r, 100));
  const second = await envoyer();
  assert.deepEqual([second.status, second.headers.get('x-operation-rejouee'), (await second.json()).code], [201, 'oui', corps.code]);
  const liste = (await appel('medecin', 'GET', '/flotte/ambulances')).corps;
  assert.equal(liste.filter((a) => a.immatriculation === 'GR-9999-KN').length, 1, 'pas de doublon');

  // Une opération refusée (4xx) n'est pas gardée : elle pourra être retentée après correction.
  const refus = () => fetch(`${api}/flotte/ambulances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jetons.medecin}`, 'X-Operation-Id': 'op-essai-0002-refus' },
    body: JSON.stringify({ modele: 'Sans immatriculation', type: 'Type A — transport' }),
  });
  assert.equal((await refus()).status, 400);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await refus()).status, 400, 'retentée normalement');
});
