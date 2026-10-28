// Tests de la relance communautaire du RECO : paramétrage validé avant activation → détection
// d'un rendez-vous CPN manqué → tâche unique attribuée au RECO du quartier → tentatives,
// orientation, synchronisation hors connexion (sans doublon, conflits signalés) → confirmation
// par le dossier de soins → indicateurs. Reprend les critères d'acceptation (section 15).
// Base MongoDB en mémoire, données fictives : aucune donnée réelle n'est lue ni écrite.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');

let serveurMongo;
let api;
let http;
let mongoose;
let moteur;
const jetons = {};
const ids = {};
const JOUR = 86400000;

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
/** Compte RECO : formulaire multipart (données JSON + photo de profil). */
async function formulaireReco(qui, methode, chemin, donnees, { photo = true } = {}) {
  const f = new FormData();
  f.append('donnees', JSON.stringify(donnees));
  if (photo) f.append('photo', new Blob([PNG], { type: 'image/png' }), 'reco.png');
  const r = await fetch(`${api}${chemin}`, { method: methode, headers: { Authorization: `Bearer ${jetons[qui]}` }, body: f });
  return { status: r.status, corps: await r.json() };
}

const ilYA = (jours) => new Date(Date.now() - jours * JOUR);
let compteur = 0;
const operationId = () => `op-essai-${Date.now()}-${(compteur += 1)}`;

before(async () => {
  serveurMongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = serveurMongo.getUri('ami_connecte_essai_relance');
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  // Photos : aucun envoi réel vers R2.
  const r2 = require('../config/r2');
  let n = 0;
  r2.envoyerFichier = async (fichier, dossier) => {
    n += 1;
    return { cle: `${dossier}/essai-${n}.png`, url: `https://public.invalid/${dossier}/essai-${n}.png` };
  };
  r2.supprimerFichier = async () => {};
  const app = require('../app');
  moteur = require('../config/moteurRelance');
  mongoose = require('mongoose');
  await mongoose.connection.asPromise();

  const jwt = require('jsonwebtoken');
  const Etablissement = require('../models/Etablissement');
  const Soignant = require('../models/Soignant');
  const Patiente = require('../models/Patiente');
  const Grossesse = require('../models/Grossesse');
  const RendezVous = require('../models/RendezVous');

  const etab = (code, nom) => Etablissement.create({
    code, nom, type: 'Centre de santé', secteur: 'Public', province: 'Kinshasa', zoneSante: 'Fictive', aireSante: 'Aire Fictive',
    adresse: 'Fictive', telephone: '000', responsable: 'Fictif', services: ['CPN'],
  });
  const csA = await etab('ETS-KIN-9901', 'CS Essai A');
  const csB = await etab('ETS-KIN-9902', 'CS Essai B');
  ids.csA = csA.id;
  ids.csB = csB.id;

  const base = {
    postnom: 'TEST', sexe: 'F', dateNaissance: '1985-01-01', lieuNaissance: 'Kinshasa', nationalite: 'Congolaise',
    pieceType: 'Passeport', adresse: 'Fictive', telephone: '000', grade: 'Fictif', specialite: 'Fictive', motDePasse: 'x',
  };
  const soignant = async (cle, role, etablissementId, matricule) => {
    const s = await Soignant.create({ ...base, prenom: cle, nom: 'ESSAI', role, matricule, email: `${cle}@relance.test`, affectations: [{ etablissementId }] });
    ids[cle] = s.id;
    jetons[cle] = jwt.sign({ sub: s.id, etablissement: etablissementId }, process.env.JWT_SECRET, { expiresIn: '10m' });
    return s;
  };
  await soignant('chef', 'Médecin chef de service', csA.id, 'MED-9901');
  await soignant('superviseur', 'Infirmier(ère) titulaire', csA.id, 'INF-9901');
  await soignant('infirmiere', 'Infirmier(ère)', csA.id, 'INF-9902');
  await soignant('superviseurB', 'Infirmier(ère) titulaire', csB.id, 'INF-9903');

  const auteur = { id: ids.chef, nom: 'Chef ESSAI', role: 'Médecin chef de service' };
  const patiente = await Patiente.create({
    numero: 'AC-PAT-990001', nom: 'Mbuyi', prenom: 'Grâce', telephone: '+243 81 000 0001', etablissementId: csA.id,
    adresse: { province: 'Kinshasa', commune: 'Lemba', quartier: 'Salongo', avenue: 'Av. Essai 1', repere: 'Près de l’école', aireSante: 'Aire Fictive' },
    consentements: { sms: true, appel: true, whatsapp: false }, creePar: auteur,
  });
  const patiente2 = await Patiente.create({
    numero: 'AC-PAT-990002', nom: 'Kalala', prenom: 'Ruth', telephone: '+243 81 000 0002', etablissementId: csA.id,
    adresse: { province: 'Kinshasa', commune: 'Lemba', quartier: 'Salongo', aireSante: 'Aire Fictive' }, creePar: auteur,
  });
  ids.patiente = patiente.id;
  ids.patiente2 = patiente2.id;
  const g1 = await Grossesse.create({ patienteId: patiente._id, numero: 1, creePar: auteur });
  const g2 = await Grossesse.create({ patienteId: patiente2._id, numero: 1, creePar: auteur });
  ids.grossesse = g1.id;
  // Rendez-vous manqués il y a 10 et 12 jours (tolérance 7 jours) ; le 2e est relié à la même tâche.
  ids.rdv1 = (await RendezVous.create({ patienteId: patiente._id, grossesseId: g1._id, date: ilYA(12), motif: 'CPN 2', etablissementId: csA.id, creePar: auteur })).id;
  ids.rdv2 = (await RendezVous.create({ patienteId: patiente._id, grossesseId: g1._id, date: ilYA(10), motif: 'CPN 3', etablissementId: csA.id, statut: 'Absent', creePar: auteur })).id;
  // Rendez-vous manqué il y a 3 jours seulement : dans la tolérance, aucune relance.
  await RendezVous.create({ patienteId: patiente2._id, grossesseId: g2._id, date: ilYA(3), motif: 'CPN 2', etablissementId: csA.id, creePar: auteur });

  http = app.listen(0);
  await new Promise((r) => http.once('listening', r));
  api = `http://127.0.0.1:${http.address().port}/api`;
});

after(async () => {
  http?.close();
  await mongoose?.disconnect();
  await serveurMongo?.stop();
});

test('Comptes RECO : création par le superviseur, refusée aux prestataires', async () => {
  const refus = await formulaireReco('infirmiere', 'POST', '/relance/recos', { prenom: 'Paul', nom: 'Refus', sexe: 'M', telephone: '0', zones: ['Salongo'] });
  assert.equal(refus.status, 403);

  const jean = { prenom: 'Jean', nom: 'Kabeya', sexe: 'M', telephone: '+243 82 000 1111', zones: ['Salongo', 'Kemi'], superviseurId: ids.superviseur };
  const sansPhoto = await formulaireReco('superviseur', 'POST', '/relance/recos', jean, { photo: false });
  assert.equal(sansPhoto.status, 400);
  assert.match(sansPhoto.corps.message, /photo/);
  const a = await formulaireReco('superviseur', 'POST', '/relance/recos', jean);
  assert.equal(a.status, 201, JSON.stringify(a.corps));
  assert.match(a.corps.reco.photo, /^https:\/\/public\.invalid\/recos\//);
  assert.equal(a.corps.reco.photoCle, undefined, 'clé R2 jamais renvoyée');
  assert.equal(a.corps.reco.matricule, 'RECO-0001');
  assert.equal(a.corps.reco.etablissementId, ids.csA);
  assert.ok(a.corps.motDePasse, 'mot de passe temporaire renvoyé une fois');
  ids.reco = a.corps.reco.id;
  ids.motDePasseReco = a.corps.motDePasse;

  const b = await formulaireReco('superviseur', 'POST', '/relance/recos', { prenom: 'Anne', nom: 'Mwamba', sexe: 'F', telephone: '0', zones: ['Livulu'], motDePasse: 'Relais@2026x' });
  assert.equal(b.status, 201);
  ids.reco2 = b.corps.reco.id;
  // Photo remplacée à la modification ; sans nouvelle photo, elle est conservée.
  const m = await formulaireReco('superviseur', 'PATCH', `/relance/recos/${ids.reco2}`, { telephone: '+243 99 000 0000' }, { photo: false });
  assert.equal(m.corps.photo, b.corps.reco.photo);
  const m2 = await formulaireReco('superviseur', 'PATCH', `/relance/recos/${ids.reco2}`, {}, { photo: true });
  assert.notEqual(m2.corps.photo, b.corps.reco.photo);

  // Un superviseur d'une autre structure ne voit pas ces RECO.
  assert.equal((await appel('superviseurB', 'GET', '/relance/recos')).corps.length, 0);

  const c = await appel(null, 'POST', '/reco/connexion', { matricule: 'RECO-0001', motDePasse: ids.motDePasseReco });
  assert.equal(c.status, 200);
  assert.equal(c.corps.reco.doitChangerMotDePasse, true);
  assert.ok(c.corps.reco.photo, 'photo affichée dans l’application RECO');
  jetons.reco = c.corps.jeton;
  jetons.reco2 = (await appel(null, 'POST', '/reco/connexion', { matricule: 'RECO-0002', motDePasse: 'Relais@2026x' })).corps.jeton;

  // Le jeton RECO n'ouvre pas les routes du personnel, et inversement.
  assert.equal((await appel('reco', 'GET', '/patientes')).status, 403);
  assert.equal((await appel('superviseur', 'GET', '/reco/taches')).status, 403);
});

test('Paramétrage : aucune relance tant que la règle et le parcours ne sont pas validés', async () => {
  await moteur.initialiserParametrage();
  const bilan = await moteur.tourner();
  assert.equal(bilan.creees, 0);

  const p = await appel('chef', 'GET', '/relance/parametrage');
  assert.equal(p.corps.parcours.length, 5);
  assert.ok(p.corps.parcours.every((x) => x.statut === 'À valider'));
  assert.ok(p.corps.regles.every((x) => x.statut === 'Inactive'));

  assert.equal((await appel('superviseur', 'PUT', '/relance/parametrage/parcours/RAC', { definition: 'x' })).status, 403);

  // Règle rattachée à un parcours non validé : activation refusée.
  await appel('chef', 'PUT', '/relance/parametrage/regles/CPN_RDV_MANQUE', { parcoursCode: 'RAC' });
  const refus = await appel('chef', 'POST', '/relance/parametrage/regles/CPN_RDV_MANQUE/activer', { responsableValidation: 'Dr Essai', referenceProtocole: 'Protocole fictif' });
  assert.equal(refus.status, 400);

  // Fiche incomplète : validation refusée.
  assert.equal((await appel('chef', 'POST', '/relance/parametrage/parcours/RAC/valider', { responsableValidation: 'Dr Essai', referenceValidation: 'PV fictif' })).status, 400);
  const m = await appel('chef', 'PUT', '/relance/parametrage/parcours/RAC', {
    libelle: 'Parcours fictif RAC', definition: 'Définition fictive de test', criteresEntree: 'Entrée fictive', criteresSortie: 'Sortie fictive',
    formuleIndicateur: 'Formule fictive', actionsAutorisees: ['Appel', 'Visite'],
  });
  assert.equal(m.status, 200);
  assert.equal(m.corps.version, 2);
  assert.equal(m.corps.historique.length, 1);
  const v = await appel('chef', 'POST', '/relance/parametrage/parcours/RAC/valider', { responsableValidation: 'Dr Essai', referenceValidation: 'PV fictif n° 1' });
  assert.equal(v.status, 200);
  assert.equal(v.corps.statut, 'Validé');

  const regle = await appel('chef', 'PUT', '/relance/parametrage/regles/CPN_RDV_MANQUE', { parametres: { toleranceJours: 7, tentativesMax: 2, delaiTraitementJours: 5 } });
  assert.equal(regle.corps.statut, 'Inactive');
  assert.equal((await appel('chef', 'PUT', '/relance/parametrage/regles/CPN_RDV_MANQUE', { parametres: { tentativesMax: 99 } })).status, 400);
  const act = await appel('chef', 'POST', '/relance/parametrage/regles/CPN_RDV_MANQUE/activer', { responsableValidation: 'Dr Essai', referenceProtocole: 'Protocole CPN fictif' });
  assert.equal(act.status, 200, JSON.stringify(act.corps));
  assert.equal(act.corps.statut, 'Active');
});

let numero;

test('Détection : un rendez-vous manqué génère une seule tâche active, attribuée au RECO du quartier', async () => {
  const bilan = await moteur.tourner();
  assert.equal(bilan.creees, 1, JSON.stringify(bilan));
  assert.equal(bilan.reliees, 1, 'le 2e rendez-vous manqué est relié à la même tâche');

  const liste = await appel('superviseur', 'GET', '/relance/taches');
  assert.equal(liste.status, 200);
  assert.equal(liste.corps.total, 1);
  const t = liste.corps.taches[0];
  numero = t.numero;
  assert.equal(t.statut, 'Attribuée');
  assert.equal(t.parcoursCode, 'RAC');
  assert.equal(t.domaine, 'CPN');
  assert.equal(t.reco.matricule, 'RECO-0001');
  assert.equal(t.motifsLies, 1);
  assert.equal(t.motif, 'Rendez-vous de consultation prénatale manqué');
  const echeance = new Date(t.echeance).getTime() - new Date(t.creeLe).getTime();
  assert.ok(Math.abs(echeance - 5 * JOUR) < 60000, 'échéance = délai de traitement de la règle');

  // Nouvelle tournée : aucune tâche de plus (pas de doublon).
  const encore = await moteur.tourner();
  assert.equal(encore.creees + encore.reliees, 0);

  // Alerte d'attribution regroupée pour le RECO.
  const alertes = await appel('reco', 'GET', '/reco/alertes');
  assert.ok(alertes.corps.some((a) => a.type === 'attribution' && a.taches.includes(numero)));
});

test('Visibilité : RECO, prestataire et autre structure ne voient que ce qui les concerne', async () => {
  const mes = await appel('reco', 'GET', '/reco/taches');
  assert.equal(mes.corps.taches.length, 1);
  const vue = mes.corps.taches[0];
  // Strict nécessaire : motif neutre, pas de détail clinique ; téléphone car appel/SMS consentis.
  assert.equal(vue.motif, 'Rendez-vous de suivi au centre de santé manqué');
  assert.deepEqual(vue.canauxAutorises, ['Appel', 'SMS', 'Visite à domicile']);
  assert.equal(vue.personne.telephone, '+243 81 000 0001');
  assert.equal(vue.personne.quartier, 'Salongo');
  assert.equal(JSON.stringify(vue).includes('CPN'), false, 'aucune mention de la grossesse dans la vue RECO');
  assert.doesNotMatch(vue.messageNeutre, /grossesse|enceinte|vaccin|CPN|prénatal/i);

  assert.equal((await appel('reco2', 'GET', '/reco/taches')).corps.taches.length, 0);
  assert.equal((await appel('reco2', 'POST', `/reco/taches/${numero}/actions`, { operationId: operationId(), type: 'accepter' })).status, 404);
  // Prestataire : la tâche n'est pas encore orientée vers sa structure.
  assert.equal((await appel('infirmiere', 'GET', '/relance/taches')).corps.total, 0);
  assert.equal((await appel('infirmiere', 'GET', `/relance/taches/${numero}`)).status, 404);
  assert.equal((await appel('superviseurB', 'GET', '/relance/taches')).corps.total, 0);
  assert.equal((await appel('infirmiere', 'GET', '/relance/tableau-de-bord')).status, 403);
});

test('Actions du RECO : canal non consenti refusé, tentatives tracées, opération rejouée sans doublon', async () => {
  const refus = await appel('reco', 'POST', `/reco/taches/${numero}/actions`, { operationId: operationId(), type: 'tentative', canal: 'WhatsApp', resultat: 'Pas de réponse' });
  assert.equal(refus.status, 403);

  const op = operationId();
  const t1 = await appel('reco', 'POST', `/reco/taches/${numero}/actions`, { operationId: op, type: 'tentative', canal: 'Appel', resultat: 'Pas de réponse' });
  assert.equal(t1.status, 200, JSON.stringify(t1.corps));
  assert.equal(t1.corps.statut, 'En cours');
  const rejoue = await appel('reco', 'POST', `/reco/taches/${numero}/actions`, { operationId: op, type: 'tentative', canal: 'Appel', resultat: 'Pas de réponse' });
  assert.equal(rejoue.corps.rejouee, true);
  assert.equal(rejoue.corps.tache.tentativesEchouees, 1, 'la tentative rejouée n’est pas comptée deux fois');

  // Orientation impossible sans contact établi.
  assert.equal((await appel('reco', 'POST', `/reco/taches/${numero}/actions`, { operationId: operationId(), type: 'orientation' })).status, 409);
});

test('Hors connexion : synchronisation ordonnée, sans doublon ; l’orientation n’est pas une réintégration', async () => {
  const visite = operationId();
  const operations = [
    // Envoyées dans le désordre : appliquées dans l'ordre où elles ont été faites.
    { operationId: operationId(), numero, type: 'orientation', structure: ids.csA, priorite: 'Normale', le: ilYA(0.01).toISOString(), horsLigne: true },
    { operationId: visite, numero, type: 'visite_realisee', resultat: 'Personne rencontrée', le: ilYA(0.02).toISOString(), horsLigne: true },
  ];
  const s = await appel('reco', 'POST', '/reco/synchroniser', { operations });
  assert.equal(s.status, 200, JSON.stringify(s.corps));
  assert.ok(s.corps.resultats.every((x) => x.ok), JSON.stringify(s.corps.resultats));
  // Renvoi complet (réseau coupé pendant la réponse) : rien n'est appliqué deux fois.
  const bis = await appel('reco', 'POST', '/reco/synchroniser', { operations });
  assert.ok(bis.corps.resultats.every((x) => x.rejouee));

  const d = await appel('superviseur', 'GET', `/relance/taches/${numero}`);
  assert.equal(d.corps.statut, 'Orientée');
  assert.equal(d.corps.actions.length, 3);
  assert.equal(d.corps.actions.filter((a) => a.horsLigne).length, 2);
  assert.ok(d.corps.contactEtabliLe);
  assert.equal(d.corps.confirmation, null);
  const statuts = d.corps.historique.map((h) => h.nouveauStatut);
  for (const s2 of ['Nouvelle', 'Attribuée', 'En cours', 'Contact établi', 'Orientée']) assert.ok(statuts.includes(s2), `historique : ${s2}`);

  // Le prestataire voit maintenant la personne orientée vers sa structure.
  const p = await appel('infirmiere', 'GET', '/relance/taches');
  assert.equal(p.corps.total, 1);

  const tb = await appel('superviseur', 'GET', '/relance/tableau-de-bord');
  const reint = tb.corps.performance.indicateurs.find((i) => i.code === 'reintegration');
  assert.equal(reint.numerateur, 0, 'orientation non comptée comme réintégration');
  assert.equal(tb.corps.performance.indicateurs.find((i) => i.code === 'contact').valeur, 100);
});

test('Confirmation par le dossier de soins, puis conflit d’une action hors ligne tardive', async () => {
  const Consultation = require('../models/Consultation');
  await Consultation.create({
    patienteId: ids.patiente, grossesseId: ids.grossesse, type: 'Suivi prénatal', date: new Date(), statut: 'Finalisée',
    auteur: { id: ids.chef, nom: 'Chef ESSAI', role: 'Médecin chef de service' },
  });
  const bilan = await moteur.tourner();
  assert.equal(bilan.confirmees, 1);
  const d = await appel('superviseur', 'GET', `/relance/taches/${numero}`);
  assert.equal(d.corps.statut, 'Réintégration confirmée');
  assert.equal(d.corps.confirmation.source, 'Dossier de soins');
  assert.equal(d.corps.confirmation.par.nom, 'Chef ESSAI');

  // Action faite hors ligne avant la clôture, reçue après : conservée en conflit, statut inchangé.
  const tardive = await appel('reco', 'POST', '/reco/synchroniser', {
    operations: [{ operationId: operationId(), numero, type: 'refus_report', motif: 'Report demandé', le: ilYA(0.005).toISOString(), horsLigne: true }],
  });
  assert.equal(tardive.corps.resultats[0].conflit, true);
  const apres = await appel('superviseur', 'GET', `/relance/taches/${numero}`);
  assert.equal(apres.corps.statut, 'Réintégration confirmée', 'une confirmation clinique n’est jamais écrasée');
  assert.equal(apres.corps.conflitsEnAttente, 1);
  const conflit = apres.corps.conflits[0];
  const arb = await appel('superviseur', 'POST', `/relance/taches/${numero}/conflits/${conflit.id}/resoudre`, { decision: 'Action antérieure à la confirmation : ignorée.' });
  assert.equal(arb.corps.conflitsEnAttente, 0);

  // Réouverture d'une réintégration confirmée refusée.
  assert.equal((await appel('superviseur', 'POST', `/relance/taches/${numero}/rouvrir`, { motif: 'essai' })).status, 409);

  const tb = await appel('superviseur', 'GET', '/relance/tableau-de-bord');
  const reint = tb.corps.performance.indicateurs.find((i) => i.code === 'reintegration');
  assert.deepEqual([reint.numerateur, reint.denominateur, reint.valeur], [1, 1, 100]);
  const rac = tb.corps.parParcours.find((p) => p.code === 'RAC');
  assert.equal(rac.effectifs.personnes, 1, 'deux motifs, une seule personne');
  assert.equal(tb.corps.parParcours.find((p) => p.code === 'ARC').effectifs.taches, 0);
  assert.equal(tb.corps.tracabilite.actionsEnConflit, 1);
});

test('Retard, échecs répétés et escalade : alertes au superviseur, clôture motivée', async () => {
  const RendezVous = require('../models/RendezVous');
  const Grossesse = require('../models/Grossesse');
  const g = await Grossesse.findOne({ patienteId: ids.patiente2 });
  await RendezVous.create({ patienteId: ids.patiente2, grossesseId: g._id, date: ilYA(9), motif: 'CPN 3', etablissementId: ids.csA, creePar: { id: ids.chef, nom: 'Chef', role: 'Médecin' } });
  await moteur.tourner();
  const liste = await appel('superviseur', 'GET', '/relance/taches?statut=ouvertes');
  const t = liste.corps.taches[0];
  assert.equal(t.reco.matricule, 'RECO-0001');
  // Patiente sans consentement téléphonique : seule la visite à domicile est proposée.
  const vue = (await appel('reco', 'GET', '/reco/taches')).corps.taches.find((x) => x.numero === t.numero);
  assert.deepEqual(vue.canauxAutorises, ['Visite à domicile']);
  assert.equal(vue.personne.telephone, '');

  for (const resultat of ['Absente du domicile', 'Adresse introuvable']) {
    await appel('reco', 'POST', `/reco/taches/${t.numero}/actions`, { operationId: operationId(), type: 'visite_realisee', resultat });
  }
  const d = await appel('superviseur', 'GET', `/relance/taches/${t.numero}`);
  assert.equal(d.corps.statut, 'Non retrouvée', 'tentativesMax = 2 atteint');
  const alertes = await appel('superviseur', 'GET', '/relance/alertes?ouvertes=1');
  assert.ok(alertes.corps.some((a) => a.type === 'echecs_multiples' && a.taches.includes(t.numero)));

  // Échéance dépassée : alerte « retard » émise une seule fois.
  const TacheRelance = require('../models/TacheRelance');
  await TacheRelance.updateOne({ numero: t.numero }, { echeance: ilYA(1) });
  await moteur.alertesPeriodiques();
  await moteur.alertesPeriodiques();
  const retard = (await appel('superviseur', 'GET', '/relance/alertes?ouvertes=1')).corps.find((a) => a.type === 'retard');
  assert.deepEqual(retard.taches, [t.numero]);
  assert.equal(retard.occurrences, 1);
  const accuse = await appel('superviseur', 'POST', `/relance/alertes/${retard.id}/accuser`);
  assert.equal(accuse.corps.ouverte, false);
  assert.equal(accuse.corps.accusePar.nom, 'superviseur ESSAI');

  assert.equal((await appel('superviseur', 'POST', `/relance/taches/${t.numero}/cloturer`, { resultat: 'Non retrouvée' })).status, 400, 'motif obligatoire');
  const c = await appel('superviseur', 'POST', `/relance/taches/${t.numero}/cloturer`, { resultat: 'Non retrouvée', motif: 'Procédure complète, adresse inconnue.' });
  assert.equal(c.corps.statut, 'Clôturée sans réintégration');
  assert.equal(c.corps.resolution.exceptionnelle, false);
  const tb = await appel('superviseur', 'GET', '/relance/tableau-de-bord');
  const nr = tb.corps.performance.indicateurs.find((i) => i.code === 'non_retrouves');
  assert.deepEqual([nr.numerateur, nr.denominateur], [1, 2]);
  // Petits effectifs (2 personnes < 5) masqués dans la désagrégation.
  assert.ok(tb.corps.equite.parAge.every((g2) => g2.masque));
});

test('Signalement du RECO et urgence : escalade immédiate, jamais gérée seul', async () => {
  const op = operationId();
  const s = await appel('reco', 'POST', '/reco/signalements', { operationId: op, nom: 'Mama Essai', quartier: 'Salongo', domaine: 'Postnatal', urgence: true, commentaire: 'Saignements signalés par la famille' });
  assert.equal(s.status, 201);
  assert.equal(s.corps.statut, 'Escaladée');
  assert.equal((await appel('reco', 'POST', '/reco/signalements', { operationId: op, nom: 'Mama Essai', quartier: 'Salongo' })).corps.rejouee, true);
  const alertes = await appel('superviseur', 'GET', '/relance/alertes?ouvertes=1');
  assert.ok(alertes.corps.some((a) => a.type === 'urgence' && a.taches.includes(s.corps.numero)));

  // Le superviseur rattache le signalement au dossier de la patiente.
  const id = await appel('superviseur', 'POST', `/relance/taches/${s.corps.numero}/identifier`, { patienteId: ids.patiente });
  assert.equal(id.status, 200, JSON.stringify(id.corps));
  assert.equal(id.corps.personne.type, 'Patiente');
});

test('Révocation : un téléphone perdu ne peut plus accéder aux tâches', async () => {
  assert.equal((await appel('reco2', 'GET', '/reco/moi')).status, 200);
  await new Promise((r) => setTimeout(r, 1100));
  const rev = await appel('superviseur', 'POST', `/relance/recos/${ids.reco2}/revoquer-sessions`);
  assert.equal(rev.status, 200);
  assert.equal((await appel('reco2', 'GET', '/reco/moi')).status, 401);
  // Nouvelle connexion possible ensuite (même seconde exclue).
  await new Promise((r) => setTimeout(r, 1100));
  const c = await appel(null, 'POST', '/reco/connexion', { matricule: 'RECO-0002', motDePasse: 'Relais@2026x' });
  assert.equal((await appel(c.corps.jeton, 'GET', '/reco/moi')).status, 200);

  const sus = await appel('superviseur', 'PATCH', `/relance/recos/${ids.reco2}/statut`, { statut: 'Suspendu' });
  assert.equal(sus.corps.statut, 'Suspendu');
  assert.equal((await appel(c.corps.jeton, 'GET', '/reco/moi')).status, 401);
});

test('Journal d’audit : actions de relance tracées, sans contenu clinique', async () => {
  const JournalAudit = require('../models/JournalAudit');
  const actions = new Set((await JournalAudit.find({ action: /^(relance|reco)\./ })).map((j) => j.action));
  for (const a of ['reco.creation', 'reco.connexion', 'relance.parametrage', 'relance.tache.action', 'reco.synchronisation', 'relance.tache.cloture', 'relance.signalement', 'reco.revocation']) {
    assert.ok(actions.has(a), a);
  }
});

test('Vaccination, accouchement et postnatal : zéro-dose prioritaire, parcours séparés, confirmation par la dose', async () => {
  const Enfant = require('../models/Enfant');
  const Grossesse = require('../models/Grossesse');
  const valider = async (code) => {
    await appel('chef', 'PUT', `/relance/parametrage/parcours/${code}`, {
      definition: `Définition fictive ${code}`, criteresEntree: 'Entrée fictive', criteresSortie: 'Sortie fictive', formuleIndicateur: 'Formule fictive',
    });
    await appel('chef', 'POST', `/relance/parametrage/parcours/${code}/valider`, { responsableValidation: 'Dr Essai', referenceValidation: `PV ${code}` });
  };
  await valider('ARC');
  await valider('TCC');
  for (const [regle, parcours] of [['VAC_DOSE_NON_DOCUMENTEE', 'ARC'], ['ACC_ISSUE_INCONNUE', 'TCC'], ['PN_VISITE_NON_DOCUMENTEE', 'TCC']]) {
    await appel('chef', 'PUT', `/relance/parametrage/regles/${regle}`, { parcoursCode: parcours });
    const a = await appel('chef', 'POST', `/relance/parametrage/regles/${regle}/activer`, { responsableValidation: 'Dr Essai', referenceProtocole: 'Protocole fictif' });
    assert.equal(a.status, 200, JSON.stringify(a.corps));
  }
  const auteur = { id: ids.chef, nom: 'Chef ESSAI', role: 'Médecin chef de service' };
  // Enfant de 4 mois sans aucune dose : zéro-dose ; né il y a plus de 42 jours (hors fenêtre postnatale).
  const enfant = await Enfant.create({
    numero: 'AC-ENF-990001', mereId: ids.patiente, etablissementId: ids.csA, origine: 'Né hors plateforme', prenom: 'Bébé', sexe: 'Féminin',
    neLe: ilYA(120), dateNaissance: '2000-01-01', creePar: auteur,
  });
  // Nouveau-né de 10 jours sans visite : relance postnatale (même parcours que l'accouchement, autre personne).
  await Enfant.create({ numero: 'AC-ENF-990002', mereId: ids.patiente2, etablissementId: ids.csA, sexe: 'Masculin', neLe: ilYA(10), dateNaissance: '2000-01-01', creePar: auteur });
  // Grossesse de la 2e patiente : DPA dépassée de 20 jours, sans issue.
  await Grossesse.updateOne({ patienteId: ids.patiente2 }, {
    datation: { methode: 'Examen clinique', dateReference: '2026-01-01', agReferenceJours: 100, dpaCalculee: '2026-01-01', dpa: new Date(Date.now() - 20 * JOUR).toISOString().slice(0, 10), valideePar: auteur, valideeLe: new Date() },
  });

  const bilan = await moteur.tourner();
  assert.equal(bilan.creees, 3, JSON.stringify(bilan));
  const liste = (await appel('superviseur', 'GET', '/relance/taches?statut=ouvertes')).corps.taches;
  const vac = liste.find((t) => t.domaine === 'Vaccination');
  assert.equal(vac.parcoursCode, 'ARC');
  assert.equal(vac.priorite, 'Prioritaire');
  assert.match(vac.motif, /zéro-dose/);
  assert.equal(vac.personne.enfant.numero, 'AC-ENF-990001');
  const tcc = liste.filter((t) => t.parcoursCode === 'TCC').map((t) => t.domaine).sort();
  assert.deepEqual(tcc, ['Accouchement', 'Postnatal']);

  // Dose enregistrée par un soignant : réintégration confirmée par le dossier de soins.
  await Enfant.updateOne({ _id: enfant._id }, { $push: { vaccinations: { code: 'penta1', date: new Date().toISOString().slice(0, 10), administreePar: auteur, le: new Date() } } });
  await moteur.tourner();
  const d = await appel('superviseur', 'GET', `/relance/taches/${vac.numero}`);
  assert.equal(d.corps.statut, 'Réintégration confirmée');
  assert.match(d.corps.confirmation.reference, /penta1/);
  assert.equal(d.corps.confirmation.avantContact, true);

  const tb = await appel('chef', 'GET', '/relance/tableau-de-bord');
  const continuum = Object.fromEntries(tb.corps.continuum.map((c) => [c.domaine, c.taches]));
  assert.equal(continuum.Vaccination, 1);
  assert.equal(continuum.Accouchement, 1);
  assert.equal(continuum.Postnatal, 2, 'naissance détectée + signalement du RECO du test précédent');
});
