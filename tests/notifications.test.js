// Tests des notifications push : rappels quotidiens (rendez-vous de la veille et du jour,
// vaccination de l'enfant), nouvel article de conseils et bouton « Envoyer les rappels » de l'agenda.
// Base MongoDB en mémoire et faux Firebase : aucune notification réelle n'est envoyée.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');

let serveurMongo;
let api;
let http;
let mongoose;
const jetons = {};
const comptes = {};
/** Envois reçus par le faux Firebase : { tokens, titre, corps, donnees }. */
const envois = [];

async function appel(qui, methode, chemin, corps) {
  const r = await fetch(`${api}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', ...(jetons[qui] ? { Authorization: `Bearer ${jetons[qui]}` } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  return { status: r.status, corps: texte ? JSON.parse(texte) : null };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function creerPatiente(corps) {
  const f = new FormData();
  f.append('donnees', JSON.stringify(corps));
  f.append('photo', new Blob([PNG], { type: 'image/png' }), 'photo.png');
  const r = await fetch(`${api}/patientes`, { method: 'POST', headers: { Authorization: `Bearer ${jetons.medecin}` }, body: f });
  return { status: r.status, corps: await r.json() };
}

async function publier(qui, champs) {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.append(k, v);
  const r = await fetch(`${api}/articles`, { method: 'POST', headers: { Authorization: `Bearer ${jetons[qui]}` }, body: f });
  return { status: r.status, corps: await r.json() };
}

/** Les annonces d'articles partent sans être attendues par la requête : on attend leur arrivée. */
async function attendreEnvois(n) {
  for (let i = 0; i < 50 && envois.length < n; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(envois.length, n);
}

const JOUR = 86400000;
let jourKinshasa;
/** Jour civil de Kinshasa décalé de n jours à partir d'aujourd'hui (AAAA-MM-JJ). */
const jour = (n) => jourKinshasa(new Date(Date.now() + n * JOUR));
/** Instant à l'heure de Kinshasa (UTC+1) d'un jour donné. */
const a = (j, heure) => new Date(`${j}T${heure}:00+01:00`);

let maman;
let sansAppli;

before(async () => {
  serveurMongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = serveurMongo.getUri('ami_connecte_essai_notifications');
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  const r2 = require('../config/r2');
  r2.envoyerFichier = async (fichier, dossier) => ({ cle: `${dossier}/essai.png`, url: `https://public.invalid/${dossier}/essai.png` });
  r2.supprimerFichier = async () => {};
  r2.urlSignee = async (cle) => (cle ? `https://signe.invalid/${cle}` : null);
  const notifications = require('../config/notifications');
  notifications.client = () => ({
    async sendEachForMulticast(m) {
      envois.push({ tokens: m.tokens, titre: m.notification.title, corps: m.notification.body, donnees: m.data });
      return {
        successCount: m.tokens.filter((t) => t !== 'perime').length,
        responses: m.tokens.map((t) => (t === 'perime' ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true })),
      };
    },
  });
  ({ jourKinshasa } = require('../config/vaccination'));
  const app = require('../app');
  mongoose = require('mongoose');
  await mongoose.connection.asPromise();
  assert.equal(mongoose.connection.name, 'ami_connecte_essai_notifications');

  const Soignant = require('../models/Soignant');
  const Etablissement = require('../models/Etablissement');
  const jwt = require('jsonwebtoken');
  const etab = await Etablissement.create({
    code: 'ETS-T-30', nom: 'Centre fictif', type: 'Centre de santé', secteur: 'Public', province: 'Kinshasa',
    zoneSante: 'ZS Fictive', adresse: 'Fictive', telephone: '000', responsable: 'Fictif', services: ['Maternité'],
  });
  const base = {
    postnom: 'TEST', sexe: 'F', dateNaissance: '1985-01-01', lieuNaissance: 'Kinshasa', nationalite: 'Congolaise',
    pieceType: 'Passeport', adresse: 'Fictive', telephone: '000', grade: 'Fictif', specialite: 'Fictive', motDePasse: 'x',
    affectations: [{ etablissementId: etab.id }],
  };
  const definitions = {
    chef: { prenom: 'Claire', nom: 'CHEF', role: 'Médecin chef de service', matricule: 'MED-9301' },
    medecin: { prenom: 'Marie', nom: 'MEDECIN', role: 'Médecin', matricule: 'MED-9302' },
    infirmiere: { prenom: 'Inès', nom: 'INFIRMIERE', role: 'Infirmier(ère)', matricule: 'INF-9301' },
  };
  for (const [cle, d] of Object.entries(definitions)) {
    comptes[cle] = await Soignant.create({ ...base, ...d, email: `${cle}@notifications.test` });
    jetons[cle] = jwt.sign({ sub: comptes[cle].id, role: d.role, etablissement: etab.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  }
  http = app.listen(0);
  await new Promise((r) => http.once('listening', r));
  api = `http://127.0.0.1:${http.address().port}/api`;

  // Deux patientes en suivi prénatal : l'une a installé l'application, l'autre non.
  const identite = (nom, prenom, email, telephone) => ({
    patiente: {
      nom, prenom, dateNaissance: '1994-04-04', telephone, email, occupation: 'Commerçante', etatCivil: 'Mariée',
      adresse: { province: 'Kinshasa', commune: 'Lemba', quartier: 'Righini' },
      contactUrgence: { nom: 'Contact', telephone: '+243 81 000 0000' },
      antecedents: { gestite: 1, parite: 0, enfantsVivants: 0, avortements: 0 },
    },
    compte: { motDePasse: 'Maman2026ok' },
    grossesse: { datation: { methode: 'DDR', ddr: jour(-90) } },
  });
  const r1 = await creerPatiente(identite('Mbuyi', 'Grace', 'grace@notifications.test', '+243 81 111 2233'));
  const r2b = await creerPatiente(identite('Ilunga', 'Rachel', 'rachel@notifications.test', '+243 82 444 5566'));
  assert.equal(r1.status, 201, JSON.stringify(r1.corps));
  assert.equal(r2b.status, 201, JSON.stringify(r2b.corps));
  maman = r1.corps;
  sansAppli = r2b.corps;
  const c = await appel(null, 'POST', '/espace-patiente/connexion', { email: 'grace@notifications.test', motDePasse: 'Maman2026ok' });
  jetons.maman = c.corps.jeton;
  assert.equal((await appel('maman', 'POST', '/espace-patiente/appareils', { jeton: 'tel-grace', plateforme: 'android' })).status, 204);
  // Rendez-vous éventuellement créés avec le dossier : on part d'un agenda vide.
  await require('../models/RendezVous').deleteMany({});
  envois.length = 0;
});

after(async () => {
  http?.close();
  await mongoose?.disconnect();
  await serveurMongo?.stop();
});

let rdvId;

test('rendez-vous planifié : notification immédiate, puis rappel la veille et le matin même, une seule fois chacun', async () => {
  const { envoyerRappels } = require('../config/rappels');
  const r = await appel('medecin', 'POST', `/patientes/${maman.id}/rendez-vous`, { date: a(jour(2), '10:00').toISOString(), motif: 'CPN 2' });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  rdvId = r.corps.id;
  await attendreEnvois(1);
  assert.equal(envois[0].titre, 'Nouveau rendez-vous');
  assert.deepEqual(envois[0].tokens, ['tel-grace']);
  assert.deepEqual(envois[0].donnees, { type: 'rendez-vous', rendezVousId: rdvId });
  assert.doesNotMatch(envois[0].corps, /CPN/, 'aucun motif médical dans la notification');

  // Hors des heures d'envoi (21 h) : rien.
  assert.equal(await envoyerRappels(a(jour(1), '21:00')), 0);
  // Veille, 9 h : rappel de demain ; une seconde tournée le même jour n'envoie rien de plus.
  assert.equal(await envoyerRappels(a(jour(1), '09:00')), 1);
  assert.equal(envois[1].titre, 'Rappel : rendez-vous demain');
  assert.equal(await envoyerRappels(a(jour(1), '09:30')), 0);
  // Jour même, 8 h 30 : rappel du matin, avec l'heure.
  assert.equal(await envoyerRappels(a(jour(2), '08:30')), 1);
  assert.equal(envois[2].titre, 'Rendez-vous aujourd’hui');
  assert.match(envois[2].corps, /10:00/);
  assert.equal(await envoyerRappels(a(jour(2), '09:00')), 0);
  assert.equal(envois.length, 3);
});

test('vaccination : séance prévue demain, dose en retard rappelée une fois par semaine ; enfant avec rendez-vous ignoré', async () => {
  const Enfant = require('../models/Enfant');
  const RendezVous = require('../models/RendezVous');
  const { envoyerRappels } = require('../config/rappels');
  const auteur = { id: comptes.medecin.id, nom: 'Marie MEDECIN', role: 'Médecin' };
  envois.length = 0;
  await RendezVous.deleteMany({});
  // Penta 1 à 6 semaines : né 42 jours avant après-demain, BCG et VPO 0 faits.
  const naissanceA = jour(12 - 42);
  const aJour = await Enfant.create({
    numero: 'AC-ENF-930001', mereId: maman.id, prenom: 'Amani', sexe: 'Féminin', neLe: a(naissanceA, '10:00'), creePar: auteur,
    vaccinations: ['bcg', 'vpo0'].map((code) => ({ code, date: naissanceA, administreePar: auteur, le: new Date() })),
  });
  // Né il y a 60 jours, rien de fait : BCG et Penta 1 en retard.
  const enRetard = await Enfant.create({ numero: 'AC-ENF-930002', mereId: maman.id, prenom: 'Baraka', sexe: 'Masculin', neLe: a(jour(-60), '10:00'), creePar: auteur });

  // J+11 : la séance d'Amani (J+12) est demain ; Baraka est en retard.
  assert.equal(await envoyerRappels(a(jour(11), '09:00')), 2);
  const parEnfant = new Map(envois.map((e) => [e.donnees.enfantId, e]));
  assert.equal(parEnfant.get(aJour.id).titre, 'Vaccination prévue demain');
  assert.match(parEnfant.get(aJour.id).corps, /Amani/);
  assert.equal(parEnfant.get(enRetard.id).titre, 'Vaccination en retard');
  assert.equal(parEnfant.get(enRetard.id).donnees.type, 'vaccination');

  // Même jour puis 3 jours plus tard : pas de relance ; 7 jours plus tard : Baraka toujours en
  // retard, et la séance d'Amani passée sans être faite (« à faire »).
  assert.equal(await envoyerRappels(a(jour(11), '15:00')), 0);
  assert.equal(await envoyerRappels(a(jour(14), '09:00')), 0);
  envois.length = 0;
  assert.equal(await envoyerRappels(a(jour(18), '09:00')), 2);
  assert.deepEqual(envois.map((e) => e.titre).sort(), ['Vaccination en retard', 'Vaccination à faire']);

  // Un rendez-vous de vaccination programmé : c'est lui qui rappelle, pas le carnet.
  // (insertMany : sans la notification « Nouveau rendez-vous » du modèle.)
  await RendezVous.insertMany({
    patienteId: maman.id, enfantId: enRetard._id, date: a(jour(40), '09:00'), motif: 'Vaccination', creePar: auteur,
    rappelPushLe: new Date(), rappelJourPushLe: new Date(),
  });
  envois.length = 0;
  assert.equal(await envoyerRappels(a(jour(20), '09:00')), 0, 'Amani rappelée il y a 2 jours, Baraka par son rendez-vous');
  assert.equal((await appel('maman', 'GET', `/espace-patiente/enfants/${enRetard.id}`)).corps.rappelVaccinJour, undefined, 'suivi interne jamais exposé');
  await Enfant.deleteMany({});
  await RendezVous.deleteMany({});
});

test('article de conseils : annoncé aux patientes concernées dès qu’il est visible (publication du chef ou approbation)', async () => {
  envois.length = 0;
  const chef = await publier('chef', { titre: 'Bien manger pendant la grossesse', contenu: 'Conseils…', cible: 'Grossesse (CPN)' });
  assert.equal(chef.status, 201, JSON.stringify(chef.corps));
  await attendreEnvois(1);
  assert.equal(envois[0].titre, 'Nouveau conseil du Dr Claire CHEF');
  assert.equal(envois[0].corps, 'Bien manger pendant la grossesse');
  assert.deepEqual(envois[0].tokens, ['tel-grace'], 'seulement les patientes qui ont l’application');
  assert.deepEqual(envois[0].donnees, { type: 'article', articleId: chef.corps.id });

  // Article d'un médecin : rien tant que le chef ne l'a pas approuvé.
  const enAttente = await publier('medecin', { titre: 'Allaitement', contenu: 'Conseils…', cible: 'Après l’accouchement' });
  assert.equal(enAttente.corps.statut, 'En attente');
  const tous = await publier('medecin', { titre: 'Se laver les mains', contenu: 'Conseils…', cible: 'Tous publics' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(envois.length, 1);
  // « Après l'accouchement » : Grace est encore enceinte, aucune patiente concernée.
  await appel('chef', 'POST', `/articles/${enAttente.corps.id}/approuver`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(envois.length, 1);
  await appel('chef', 'POST', `/articles/${tous.corps.id}/approuver`);
  await attendreEnvois(2);
  assert.equal(envois[1].titre, 'Nouveau conseil du Dr Marie MEDECIN');
});

test('bouton « Envoyer les rappels » : médecins seulement, prochain rendez-vous de chaque patiente, pas deux fois de suite', async () => {
  const RendezVous = require('../models/RendezVous');
  const Patiente = require('../models/Patiente');
  const auteur = { id: comptes.medecin.id, nom: 'Marie MEDECIN', role: 'Médecin' };
  await RendezVous.insertMany([
    { patienteId: maman.id, date: a(jour(5), '09:00'), motif: 'CPN 3', creePar: auteur },
    { patienteId: maman.id, date: a(jour(12), '09:00'), motif: 'Échographie', creePar: auteur },
    { patienteId: sansAppli.id, date: a(jour(3), '11:00'), motif: 'CPN 2', creePar: auteur },
    { patienteId: sansAppli.id, date: a(jour(60), '11:00'), motif: 'Hors horizon', creePar: auteur },
    { patienteId: maman.id, date: a(jour(-2), '09:00'), motif: 'Passé', creePar: auteur },
  ]);
  // Un ancien téléphone de Grace : jeton périmé, oublié après l'envoi.
  await Patiente.updateOne({ _id: maman.id }, { $push: { appareils: { jeton: 'perime', plateforme: 'android', le: new Date() } } });
  envois.length = 0;

  assert.equal((await appel('infirmiere', 'POST', '/rendez-vous/rappels')).status, 403);
  const r = await appel('medecin', 'POST', '/rendez-vous/rappels');
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.deepEqual(r.corps, { rendezVous: 3, patientes: 2, notifiees: 1, horizonJours: 30 });
  assert.equal(envois.length, 1);
  assert.equal(envois[0].titre, 'Rappel : prochain rendez-vous');
  assert.match(envois[0].corps, /1 autre rendez-vous prévu ensuite/);
  assert.deepEqual(envois[0].tokens, ['tel-grace', 'perime']);
  assert.deepEqual((await Patiente.findById(maman.id).select('+appareils')).appareils.map((x) => x.jeton), ['tel-grace']);

  const encore = await appel('chef', 'POST', '/rendez-vous/rappels');
  assert.equal(encore.status, 429);
  assert.match(encore.corps.message, /déjà envoyés par Marie MEDECIN/);
  const journal = await appel('chef', 'GET', '/journal?action=rdv.rappels');
  assert.equal(journal.corps.total, 1);
});
