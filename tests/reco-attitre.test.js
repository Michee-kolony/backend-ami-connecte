// RECO attitré (demande du médecin) : à l'enregistrement CPN, la patiente est confiée au RECO de
// son quartier (sinon de sa commune, sinon de son aire de santé) ; le RECO ne voit que ses
// patientes, reçoit leurs alertes et leurs tâches de relance ; un RECO suspendu passe la main.
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
async function multipart(qui, methode, chemin, donnees) {
  const f = new FormData();
  f.append('donnees', JSON.stringify(donnees));
  f.append('photo', new Blob([PNG], { type: 'image/png' }), 'photo.png');
  const r = await fetch(`${api}${chemin}`, { method: methode, headers: { Authorization: `Bearer ${jetons[qui]}` }, body: f });
  return { status: r.status, corps: await r.json() };
}

let compteur = 0;
/** Enregistrement CPN (formulaire du tableau de bord). */
const enregistrer = (adresse, extra = {}) => multipart('medecin', 'POST', '/patientes', {
  patiente: {
    nom: `Essai${(compteur += 1)}`, prenom: 'Grâce', ageDeclare: 25, telephone: `+243 81 000 ${1000 + compteur}`,
    email: `attitre${compteur}@essai.test`, adresse: { province: 'Kinshasa', ...adresse }, consentements: { sms: true, appel: true, whatsapp: false },
  },
  compte: { motDePasse: 'Grossesse2026' },
  ...extra,
});

/** RECO créé par le superviseur, puis connecté à l'application RECO. */
async function reco(cle, champs) {
  const r = await multipart('superviseur', 'POST', '/relance/recos', { sexe: 'F', telephone: '0', motDePasse: 'Relais@2026x', doitChangerMotDePasse: false, ...champs });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  ids[cle] = r.corps.reco.id;
  const c = await appel(null, 'POST', '/reco/connexion', { matricule: r.corps.reco.matricule, motDePasse: 'Relais@2026x' });
  assert.equal(c.status, 200);
  jetons[cle] = c.corps.jeton;
}

const mesPatientes = async (cle) => (await appel(cle, 'GET', '/reco/patientes')).corps.patientes.map((p) => p.numero);
const alertesDe = async (cle) => (await appel(cle, 'GET', '/reco/alertes')).corps;

before(async () => {
  serveurMongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = serveurMongo.getUri('ami_connecte_essai_reco_attitre');
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  const r2 = require('../config/r2');
  let n = 0;
  r2.envoyerFichier = async (fichier, dossier) => ({ cle: `${dossier}/essai-${(n += 1)}.png`, url: `https://public.invalid/${dossier}/essai-${n}.png` });
  r2.supprimerFichier = async () => {};
  r2.urlSignee = async (cle) => (cle ? `https://signe.invalid/${cle}` : null);
  const app = require('../app');
  mongoose = require('mongoose');
  await mongoose.connection.asPromise();

  const jwt = require('jsonwebtoken');
  const Etablissement = require('../models/Etablissement');
  const Soignant = require('../models/Soignant');
  const etab = (code, nom) => Etablissement.create({
    code, nom, type: 'Centre de santé', secteur: 'Public', province: 'Kinshasa', zoneSante: 'Fictive', aireSante: 'Aire Fictive',
    adresse: 'Fictive', telephone: '000', responsable: 'Fictif', services: ['CPN'],
  });
  const cs = await etab('ETS-KIN-9951', 'CS Attitré');
  const autre = await etab('ETS-KIN-9952', 'CS Voisin');
  ids.cs = cs.id;
  const base = {
    postnom: 'TEST', sexe: 'F', dateNaissance: '1985-01-01', lieuNaissance: 'Kinshasa', nationalite: 'Congolaise',
    pieceType: 'Passeport', adresse: 'Fictive', telephone: '000', grade: 'Fictif', specialite: 'Fictive', motDePasse: 'x',
  };
  const soignant = async (cle, role, etablissementId, matricule) => {
    const s = await Soignant.create({ ...base, prenom: cle, nom: 'ESSAI', role, matricule, email: `${cle}@attitre.test`, affectations: [{ etablissementId }] });
    jetons[cle] = jwt.sign({ sub: s.id, etablissement: etablissementId }, process.env.JWT_SECRET, { expiresIn: '10m' });
  };
  await soignant('medecin', 'Médecin chef de service', cs.id, 'MED-9951');
  await soignant('superviseur', 'Infirmier(ère) titulaire', cs.id, 'INF-9951');
  await soignant('superviseurVoisin', 'Infirmier(ère) titulaire', autre.id, 'INF-9952');

  http = app.listen(0);
  await new Promise((r) => http.once('listening', r));
  api = `http://127.0.0.1:${http.address().port}/api`;

  // Jean couvre le quartier Salongo ; Anne la commune de Matete ; Paul n'a pas de zone (aire de santé).
  await reco('jean', { prenom: 'Jean', nom: 'Kabeya', zones: ['Salongo'] });
  await reco('anne', { prenom: 'Anne', nom: 'Mwamba', zones: ['Matete'] });
  await reco('paul', { prenom: 'Paul', nom: 'Lukusa', zones: [] });
});

after(async () => {
  http?.close();
  await mongoose?.disconnect();
  await serveurMongo?.stop();
});

test('Enregistrement CPN : la patiente est confiée au RECO de son quartier, qui en est alerté', async () => {
  const r = await enregistrer({ commune: 'Lemba', quartier: '  salongo ' });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  assert.equal(r.corps.reco?.id, ids.jean, 'quartier comparé sans casse ni espaces');
  assert.equal(r.corps.reco.mode, 'Automatique');
  ids.grace = r.corps;

  assert.deepEqual(await mesPatientes('jean'), [r.corps.numero]);
  const alerte = (await alertesDe('jean')).find((a) => a.type === 'patiente_affectee');
  assert.ok(alerte?.ouverte, 'alerte « nouvelle patiente confiée »');
  assert.match(alerte.messages[0].texte, new RegExp(r.corps.numero));

  // Le dossier et la fiche de suivi affichent le RECO attitré.
  const dossier = await appel('medecin', 'GET', `/patientes/${r.corps.id}`);
  assert.equal(dossier.corps.reco.id, ids.jean);
  assert.equal((await appel('superviseur', 'GET', `/patientes/${r.corps.id}/suivi`)).corps.reco.id, ids.jean);
});

test('Sans RECO du quartier : celui de la commune, puis celui de l’aire de santé', async () => {
  const commune = await enregistrer({ commune: 'Matete', quartier: 'Kinsaku' });
  assert.equal(commune.corps.reco?.id, ids.anne, 'commune couverte par Anne');
  const aire = await enregistrer({ commune: 'Kalamu', quartier: 'Yolo', aireSante: 'Aire Fictive' });
  assert.equal(aire.corps.reco?.id, ids.paul, 'même aire de santé');
  ids.yolo = aire.corps;
});

test('Aucun RECO du secteur : la supervision est alertée, puis un nouveau RECO reprend la patiente', async () => {
  const r = await enregistrer({ commune: 'Kintambo', quartier: 'Jamaïque', aireSante: 'Autre aire' });
  assert.equal(r.status, 201);
  assert.equal(r.corps.reco, null);
  const alertes = await appel('superviseur', 'GET', '/relance/alertes');
  assert.ok(JSON.stringify(alertes.corps).includes('patiente_sans_reco'), JSON.stringify(alertes.corps).slice(0, 300));

  await reco('marie', { prenom: 'Marie', nom: 'Ilunga', zones: ['Jamaïque'] });
  assert.deepEqual(await mesPatientes('marie'), [r.corps.numero], 'reprise automatique à la création du RECO');
  ids.jamaique = r.corps;
});

test('Un RECO plus précis reprend les patientes confiées par l’aire de santé ; les choix manuels sont gardés', async () => {
  // Choix manuel : la patiente de Yolo reste chez Paul même si un RECO de Yolo arrive.
  const manuel = await appel('medecin', 'PUT', `/patientes/${ids.yolo.id}/reco`, { recoId: ids.paul });
  assert.equal(manuel.status, 200);
  assert.equal(manuel.corps.reco.mode, 'Manuelle');
  const yolo2 = await enregistrer({ commune: 'Kalamu', quartier: 'Yolo', aireSante: 'Aire Fictive' });
  assert.equal(yolo2.corps.reco.id, ids.paul);

  await reco('luc', { prenom: 'Luc', nom: 'Tshala', zones: ['Yolo'] });
  assert.deepEqual(await mesPatientes('luc'), [yolo2.corps.numero], 'reprend la patiente automatique de son quartier');
  assert.deepEqual(await mesPatientes('paul'), [ids.yolo.numero], 'garde la patiente désignée à la main');
  assert.ok((await alertesDe('paul')).some((a) => a.type === 'patiente_retiree'), 'Paul est prévenu du départ');
});

test('Visibilité : chaque RECO ne voit que ses patientes, sans donnée clinique', async () => {
  const anne = await appel('anne', 'GET', '/reco/patientes');
  assert.equal(anne.status, 200);
  assert.ok(!anne.corps.patientes.some((p) => p.numero === ids.grace.numero), 'la patiente de Jean est invisible pour Anne');
  const [p] = (await appel('jean', 'GET', '/reco/patientes')).corps.patientes;
  assert.equal(p.quartier, 'salongo');
  assert.ok(p.telephone, 'téléphone visible : appel et SMS consentis');
  assert.ok(p.photoUrl);
  for (const cle of ['antecedents', 'groupeSanguin', 'facteursRisque', 'consultations', 'email']) assert.equal(p[cle], undefined, cle);
  // Le personnel n'a pas accès à cette route ; une patiente d'une autre structure ne peut pas être confiée.
  assert.equal((await appel('medecin', 'GET', '/reco/patientes')).status, 403);
  assert.equal((await appel('superviseurVoisin', 'PUT', `/patientes/${ids.grace.id}/reco`, { recoId: ids.anne })).status, 403);
});

test('Liste des RECO possibles : le RECO conseillé est marqué ; RECO inconnu refusé', async () => {
  const r = await appel('superviseur', 'GET', `/patientes/${ids.grace.id}/recos`);
  assert.equal(r.status, 200);
  assert.equal(r.corps.find((x) => x.conseille)?.id, ids.jean);
  const refus = await appel('superviseur', 'PUT', `/patientes/${ids.grace.id}/reco`, { recoId: new mongoose.Types.ObjectId().toString() });
  assert.equal(refus.status, 400);
});

test('Adresse modifiée : le RECO du nouveau quartier reprend le suivi', async () => {
  const m = await appel('medecin', 'PATCH', `/patientes/${ids.jamaique.id}`, { adresse: { province: 'Kinshasa', commune: 'Lemba', quartier: 'Salongo' } });
  assert.equal(m.status, 200, JSON.stringify(m.corps));
  assert.equal(m.corps.reco.id, ids.jean);
  assert.deepEqual(await mesPatientes('marie'), []);
});

test('Les tâches de relance de la patiente vont à son RECO attitré', async () => {
  const TacheRelance = require('../models/TacheRelance');
  const moteur = require('../config/moteurRelance');
  const Patiente = require('../models/Patiente');
  // La patiente de Jean change de RECO à la main : une tâche ouverte la suit.
  const p = await Patiente.findById(ids.grace.id);
  const tache = await TacheRelance.create({
    numero: 'REL-ESSAI-1', parcoursCode: 'CPN', parcoursVersion: 1, domaine: 'CPN', source: 'Détection automatique',
    personneType: 'Patiente', patienteId: p._id, cle: 'essai', etablissementId: ids.cs, priorite: 'Normale',
    parametres: { delaiTraitementJours: 3, tentativesMax: 3, alerteAvantEcheanceJours: 1 }, dateEvenement: new Date(), echeance: new Date(Date.now() + 3 * 86400000),
    creePar: { id: 'systeme', nom: 'Essai', role: 'Système' },
  });
  moteur.attribuer(tache, await require('../models/Reco').findById(ids.jean), { id: 'systeme', nom: 'Essai', role: 'Système' });
  await tache.save();
  const r = await appel('medecin', 'PUT', `/patientes/${ids.grace.id}/reco`, { recoId: ids.anne });
  assert.equal(r.status, 200);
  assert.equal(String((await TacheRelance.findById(tache._id)).recoId), ids.anne, 'la tâche ouverte suit la patiente');
  assert.ok((await alertesDe('anne')).some((a) => a.type === 'attribution' && a.taches.includes('REL-ESSAI-1')));
});

test('RECO suspendu : ses patientes passent à un autre RECO du secteur, sinon la supervision est alertée', async () => {
  // Paul (aire de santé) suit la patiente de Yolo désignée à la main ; Luc couvre Yolo.
  const s = await appel('superviseur', 'PATCH', `/relance/recos/${ids.paul}/statut`, { statut: 'Suspendu' });
  assert.equal(s.status, 200);
  assert.ok((await mesPatientes('luc')).includes(ids.yolo.numero), 'reprise par le RECO de son quartier');
  const Patiente = require('../models/Patiente');
  assert.equal((await Patiente.findById(ids.yolo.id)).recoAffectation.mode, 'Automatique');
});
