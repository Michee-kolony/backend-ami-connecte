// Tests du module accouchement : admission → partogramme et alertes → accouchement → nouveau-né
// → post-partum → sortie et clôture, carnet vaccinal (PEV RDC) et espace patiente.
// Base MongoDB en mémoire, données fictives : aucune donnée réelle n'est lue ni écrite.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');

let serveurMongo;
let api;
let http;
let mongoose;
const jetons = {};
const comptes = {};

async function appel(qui, methode, chemin, corps) {
  const jeton = jetons[qui] ?? qui; // un nom de compte, ou directement un jeton
  const r = await fetch(`${api}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
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

/** Admission directe (sans dossier) : formulaire multipart (données + photo de la patiente, sauf `sansPhoto`). */
async function admissionDirecte(qui, donnees, { sansPhoto = false } = {}) {
  const f = new FormData();
  f.append('donnees', JSON.stringify(donnees));
  if (!sansPhoto) f.append('photo', new Blob([PNG], { type: 'image/png' }), 'patiente.png');
  const r = await fetch(`${api}/accouchements`, { method: 'POST', headers: { Authorization: `Bearer ${jetons[qui]}` }, body: f });
  return { status: r.status, corps: await r.json() };
}

/** Enfant né hors plateforme : multipart (données + photo de l'enfant + photo de la nouvelle mère). */
async function enregistrerEnfant(qui, donnees, { photo = true, photoMere = false } = {}) {
  const f = new FormData();
  f.append('donnees', JSON.stringify(donnees));
  if (photo) f.append('photo', new Blob([PNG], { type: 'image/png' }), 'enfant.png');
  if (photoMere) f.append('photoMere', new Blob([PNG], { type: 'image/png' }), 'mere.png');
  const r = await fetch(`${api}/enfants`, { method: 'POST', headers: { Authorization: `Bearer ${jetons[qui]}` }, body: f });
  return { status: r.status, corps: await r.json() };
}

/** Nouveau-né : formulaire multipart (données + photo, sauf `sansPhoto`). */
async function ajouterNouveauNe(qui, dossier, donnees, { sansPhoto = false } = {}) {
  const f = new FormData();
  f.append('donnees', JSON.stringify(donnees));
  if (!sansPhoto) f.append('photo', new Blob([PNG], { type: 'image/png' }), 'bebe.png');
  const r = await fetch(`${api}/accouchements/${dossier}/nouveau-nes`, { method: 'POST', headers: { Authorization: `Bearer ${jetons[qui]}` }, body: f });
  return { status: r.status, corps: await r.json() };
}

const ilYaH = (h) => new Date(Date.now() - h * 3600000).toISOString();
const ilYaJ = (j) => new Date(Date.now() - j * 86400000).toISOString().slice(0, 10);

before(async () => {
  serveurMongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = serveurMongo.getUri('ami_connecte_essai_accouchement');
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  const r2 = require('../config/r2');
  r2.envoyerFichier = async (fichier, dossier) => ({ cle: `${dossier}/essai.png`, url: `https://public.invalid/${dossier}/essai.png` });
  r2.supprimerFichier = async () => {};
  r2.urlSignee = async (cle) => (cle ? `https://signe.invalid/${cle}` : null);
  const app = require('../app');
  mongoose = require('mongoose');
  await mongoose.connection.asPromise();
  assert.equal(mongoose.connection.name, 'ami_connecte_essai_accouchement');

  const Soignant = require('../models/Soignant');
  const Etablissement = require('../models/Etablissement');
  const jwt = require('jsonwebtoken');
  const etab = await Etablissement.create({
    code: 'ETS-T-20', nom: 'Maternité fictive', type: 'Centre de santé', secteur: 'Public', province: 'Kinshasa',
    zoneSante: 'ZS Fictive', adresse: 'Fictive', telephone: '000', responsable: 'Fictif', services: ['Maternité'],
  });
  const base = {
    postnom: 'TEST', sexe: 'F', dateNaissance: '1985-01-01', lieuNaissance: 'Kinshasa', nationalite: 'Congolaise',
    pieceType: 'Passeport', adresse: 'Fictive', telephone: '000', grade: 'Fictif', specialite: 'Fictive', motDePasse: 'x',
  };
  const definitions = {
    medecin: { prenom: 'Marie', nom: 'MEDECIN', role: 'Médecin', matricule: 'MED-9101', affectations: [{ etablissementId: etab.id }] },
    autreMedecin: { prenom: 'Paul', nom: 'AILLEURS', role: 'Médecin', matricule: 'MED-9102', affectations: [{ etablissementId: 'AUTRE' }] },
    sageFemme: { prenom: 'Sarah', nom: 'SAGEFEMME', role: 'Sage-femme', matricule: 'SFM-9101', affectations: [{ etablissementId: etab.id }] },
    infirmiere: { prenom: 'Inès', nom: 'INFIRMIERE', role: 'Infirmier(ère)', matricule: 'INF-9101', affectations: [{ etablissementId: etab.id }] },
  };
  for (const [cle, d] of Object.entries(definitions)) {
    comptes[cle] = await Soignant.create({ ...base, ...d, email: `${cle}@accouchement.test` });
    jetons[cle] = jwt.sign({ sub: comptes[cle].id, role: d.role, etablissement: etab.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
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

test('partogramme : zones verte / jaune / rouge (ligne d’alerte 1 cm/h, ligne d’action 4 h à droite)', () => {
  const { zoneDilatation } = require('../config/partogramme');
  assert.equal(zoneDilatation(0, 4), 'Verte');
  assert.equal(zoneDilatation(3, 7), 'Verte', 'sur la ligne d’alerte');
  assert.equal(zoneDilatation(3, 5), 'Jaune');
  assert.equal(zoneDilatation(5, 5), 'Jaune', 'sur la ligne d’action');
  assert.equal(zoneDilatation(6, 5), 'Rouge');
  assert.equal(zoneDilatation(12, 10), 'Verte', 'dilatation complète');
});

test('calendrier PEV RDC : dates des séances, intervalle de 4 semaines dans une série, VPO 0 hors délai après 14 jours', () => {
  const { calendrier, dateAge } = require('../config/vaccination');
  assert.equal(dateAge('2026-01-31', { mois: 1 }), '2026-02-28', 'mois plus court : dernier jour du mois');
  const c = calendrier('2026-01-01', [], '2026-01-01');
  const dose = (code) => c.doses.find((d) => d.code === code);
  assert.equal(dose('bcg').statut, 'À faire');
  assert.equal(dose('penta1').datePrevue, '2026-02-12', '6 semaines');
  assert.equal(dose('penta3').datePrevue, '2026-04-09', '14 semaines');
  assert.equal(dose('var1').datePrevue, '2026-10-01', '9 mois');
  assert.deepEqual(c.prochaineSeance.doses.map((d) => d.code), ['bcg', 'vpo0']);

  // Penta 1 fait en retard : Penta 2 au moins 28 jours après.
  const tard = calendrier('2026-01-01', [{ code: 'penta1', date: '2026-03-01' }], '2026-03-01');
  assert.equal(tard.doses.find((d) => d.code === 'penta2').datePrevue, '2026-03-29');
  assert.equal(tard.doses.find((d) => d.code === 'vpo0').statut, 'Hors délai');
  assert.equal(tard.doses.find((d) => d.code === 'bcg').statut, 'En retard');
});

test('calendrier PEV RDC : vaccin antipaludique (6, 7, 8 et 15 mois) et rougeole-rubéole (RR1, RR2)', () => {
  const { calendrier } = require('../config/vaccination');
  const c = calendrier('2026-01-01', [], '2026-01-01');
  const dose = (code) => c.doses.find((d) => d.code === code);
  assert.deepEqual(['palu1', 'palu2', 'palu3', 'palu4'].map((x) => dose(x).datePrevue), ['2026-07-01', '2026-08-01', '2026-09-01', '2027-04-01']);
  assert.equal(dose('palu1').maladies, 'Paludisme');
  assert.equal(dose('var1').maladies, 'Rougeole, rubéole');
  assert.equal(dose('var2').libelle, 'RR2');
  // Séances dans l'ordre chronologique : la vitamine A de 6 mois rejoint le vaccin antipaludique.
  const seances = [...new Set(c.doses.map((d) => d.seance))];
  assert.deepEqual(seances.slice(0, 9), ['Naissance', '6 semaines', '10 semaines', '14 semaines', '6 mois', '7 mois', '8 mois', '9 mois', '12 mois']);
  assert.deepEqual(c.doses.filter((d) => d.seance === '15 mois').map((d) => d.code), ['var2', 'palu4']);

  // Dose 1 faite en retard : la dose 2 au moins 4 semaines après.
  const tard = calendrier('2026-01-01', [{ code: 'palu1', date: '2026-07-20' }], '2026-07-20');
  assert.equal(tard.doses.find((d) => d.code === 'palu2').datePrevue, '2026-08-17');
});

let patiente;
let dossierId;
let enfantId;

test('admission : réservée aux médecins et sages-femmes, identité et anamnèse pré-remplies', async () => {
  const r = await creerPatiente({
    patiente: {
      nom: 'Kabila', prenom: 'Esther', dateNaissance: '1995-05-05', telephone: '+243 81 222 3344', email: 'esther@essai.test',
      occupation: 'Commerçante', etatCivil: 'Mariée', nomPartenaire: 'Jean', groupeSanguin: 'O', rhesus: 'Positif', electrophoreseHb: 'AS',
      adresse: { province: 'Kinshasa', commune: 'Lemba', quartier: 'Righini' },
      contactUrgence: { nom: 'Jean Kabila', telephone: '+243 81 000 0000' },
      antecedents: { gestite: 3, parite: 2, enfantsVivants: 2, avortements: 0 },
    },
    compte: { motDePasse: 'Bebe2026ok' },
    grossesse: { datation: { methode: 'DDR', ddr: ilYaJ(275) } },
  });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  patiente = r.corps;

  const refus = await appel('infirmiere', 'POST', '/accouchements', { patienteId: patiente.id });
  assert.equal(refus.status, 403, 'infirmière refusée');

  const a = await appel('sageFemme', 'POST', '/accouchements', {
    patienteId: patiente.numero,
    admission: { admiseLe: ilYaH(12), motif: 'Contractions utérines douloureuses', provenance: 'AS', debutTravail: ilYaH(14), vih: { conseillee: true, testee: true, informee: true } },
  });
  assert.equal(a.status, 201, JSON.stringify(a.corps));
  dossierId = a.corps.id;
  assert.match(a.corps.numero, /^AC-ACC-\d{6}$/);
  const adm = a.corps.admission;
  assert.equal(adm.nom, 'KABILA');
  assert.equal(adm.occupation, 'Commerçante');
  assert.equal(adm.statutHb, 'AS');
  assert.equal(adm.gestite, 3);
  assert.equal(adm.personneAPrevenir.nom, 'Jean Kabila');
  assert.ok(adm.dpa, 'DPA reprise de la grossesse');
  assert.equal(adm.provenance, 'AS');
  assert.equal(adm.admisePar.id, comptes.sageFemme.id);

  const double = await appel('medecin', 'POST', '/accouchements', { patienteId: patiente.id });
  assert.equal(double.status, 409, 'un seul dossier par grossesse');
});

test('ouverture du dossier : données du suivi prénatal pré-remplies et points d’attention', async () => {
  const r = await creerPatiente({
    patiente: {
      nom: 'Mbuyi', prenom: 'Ruth', dateNaissance: '1990-02-02', telephone: '+243 81 333 4455', email: 'ruth@essai.test',
      groupeSanguin: 'A', rhesus: 'Négatif', tailleCm: 158, adresse: { province: 'Kinshasa' },
      antecedents: {
        gestite: 4, parite: 2, enfantsVivants: 2, cesariennes: 1, allergies: 'Pénicilline',
        atcdMedicaux: ['Hypertension artérielle (HTA)'], atcdObstetricaux: ['Dystocie'],
      },
    },
    compte: { motDePasse: 'Bebe2026ok' },
    grossesse: { datation: { methode: 'DDR', ddr: ilYaJ(266) } },
  });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  const Grossesse = require('../models/Grossesse');
  const Consultation = require('../models/Consultation');
  const Echographie = require('../models/Echographie');
  const g = await Grossesse.findOne({ patienteId: r.corps.id });
  const auteur = { id: comptes.medecin.id, nom: 'Marie MEDECIN', role: 'Médecin' };
  const commun = { patienteId: g.patienteId, grossesseId: g._id, type: 'Suivi prénatal', auteur, statut: 'Finalisée' };
  await Consultation.create({
    ...commun, date: new Date(Date.now() - 40 * 86400000),
    laboratoire: { hb: '9,1' }, mesuresPreventives: { resultatTest: { reponse: true, valeur: 'négatif' }, dcip: { reponse: true }, rpr: { reponse: false } },
  });
  await Consultation.create({
    ...commun, date: new Date(Date.now() - 10 * 86400000),
    constantes: { poidsKg: 72, taSystolique: 130, taDiastolique: 85, hauteurUterineCm: 34 }, examenCpn: { presentation: 'Siège' },
  });
  await Consultation.create({ ...commun, date: new Date(), statut: 'Brouillon', laboratoire: { hb: '15' } });
  await Echographie.create({ ...commun, date: ilYaJ(20), nombreFoetus: 1, foetus: [{ presentation: 'Siège', poidsEstimeG: 2900 }] });

  const a = await appel('medecin', 'POST', '/accouchements', { patienteId: r.corps.id, admission: { admiseLe: ilYaH(1) } });
  assert.equal(a.status, 201, JSON.stringify(a.corps));
  const adm = a.corps.admission;
  assert.equal(adm.rhesus, 'Négatif');
  assert.deepEqual(adm.vih, { conseillee: true, testee: true, informee: true, resultat: 'Négatif' });
  assert.equal(adm.antecedents.gynecoObstetricaux.cesariennes.length, 1, 'une ligne par césarienne antérieure');
  assert.match(adm.antecedents.medicoChirurgicaux, /Allergies : Pénicilline/);
  assert.match(adm.antecedents.gynecoObstetricaux.autres, /Dystocie/);

  // Examen d'entrée : données durables proposées, mesures du jour laissées vides.
  const ex = a.corps.preRemplissage.examen;
  assert.equal(ex.physique.tailleCm, 158);
  assert.equal(ex.physique.poidsKg, undefined, 'le poids de la CPN n’est pas recopié');
  assert.equal(ex.laboratoire.gs, 'A−');
  assert.match(ex.laboratoire.hb, /^9,1 \(CPN du /, 'consultation brouillon ignorée');
  assert.match(ex.laboratoire.rprSyphilis, /^Négatif/);

  const rp = a.corps.rappelPrenatal;
  assert.equal(rp.nombreCpn, 2);
  assert.equal(rp.derniereCpn.poidsKg, 72);
  assert.equal(rp.echographie.poidsEstimeG, 2900);
  const textes = rp.points.map((p) => p.texte).join(' | ');
  for (const attendu of [/Allergies : Pénicilline/, /Utérus cicatriciel/, /Rhésus négatif/, /HTA/, /Présentation siège/, /Anémie : Hb 9,1/]) {
    assert.match(textes, attendu);
  }

  const supp = await appel('medecin', 'DELETE', `/accouchements/${a.corps.id}`, { confirmation: a.corps.numero });
  assert.equal(supp.status, 204);
});

test('examen clinique d’entrée : examinateur = soignant connecté', async () => {
  const r = await appel('sageFemme', 'PUT', `/accouchements/${dossierId}/examen-clinique`, {
    examineLe: ilYaH(11.9),
    physique: { poidsKg: 68, temperature: 37.2, pouls: 88, taSystolique: 120, taDiastolique: 80, oedemes: false, conjonctives: 'Colorées', systemes: { respiratoire: 'RAS' } },
    obstetrical: {
      hauteurUterineCm: 33, presentation: 'Sommet', position: 'OIGA', bcf: 140, mouvementsFoetauxActifs: true,
      toucherVaginal: { effacementPct: 50, dilatationCm: 2 }, pocheEaux: { etat: 'Rompue', rompueLe: ilYaH(13), aspectLiquide: 'Clair' },
      engagement: 'Amorcée', bassin: 'Bon',
    },
    laboratoire: { hb: '11,5 g/dl', tdrPalu: 'Négatif', rprSyphilis: 'Négatif' },
    conclusion: 'Travail en phase de latence', conduiteATenir: 'Surveillance',
  });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.equal(r.corps.examenClinique.examinateur.id, comptes.sageFemme.id);
  assert.equal(r.corps.examenClinique.obstetrical.pocheEaux.aspectLiquide, 'Clair');
});

test('surveillance du travail : latence puis phase active, alertes BCF, zone jaune, stagnation et zone rouge', async () => {
  const saisir = (corps) => appel('sageFemme', 'POST', `/accouchements/${dossierId}/surveillances`, corps);
  assert.equal((await saisir({})).status, 400, 'au moins une mesure');

  const latence = await saisir({ le: ilYaH(11), dilatationCm: 2, effacementPct: 30, bcf: 140, contractions10min: 2, dureeContractionsSec: 30, saignement: '0' });
  assert.equal(latence.status, 201, JSON.stringify(latence.corps));
  assert.equal(latence.corps.surveillance.phase, 'Latence');
  assert.equal(latence.corps.alertes.length, 0);

  const debutActive = await saisir({ le: ilYaH(10), dilatationCm: 4, bcf: 170, membranes: 'Rompues', liquideAmniotique: 'Clair', engagement: 'F' });
  assert.equal(debutActive.corps.surveillance.phase, 'Active');
  assert.deepEqual(debutActive.corps.alertes.map((x) => x.code), ['BCF'], 'BCF > 160');
  assert.equal(debutActive.corps.alertes[0].sonore, true);

  const jaune = await saisir({ le: ilYaH(8), dilatationCm: 5, effacementPct: 70, bcf: 138 });
  assert.deepEqual(jaune.corps.alertes.map((x) => x.code), ['Zone jaune']);

  const stagnation = await saisir({ le: ilYaH(6), dilatationCm: 5, bcf: 135 });
  assert.deepEqual(stagnation.corps.alertes.map((x) => x.code), ['Stagnation'], 'pas de progression depuis 2 h en zone jaune');
  assert.equal(stagnation.corps.alertes[0].sonore, true);

  const rouge = await saisir({ le: ilYaH(3), dilatationCm: 6, bcf: 110, ocytocine: { uParMl: 5, gouttesMin: 20 } });
  assert.deepEqual(rouge.corps.alertes.map((x) => x.code).sort(), ['BCF', 'Zone rouge']);
  const alerteRouge = rouge.corps.alertes.find((x) => x.code === 'Zone rouge');
  assert.deepEqual(alerteRouge.medecinsNotifies, [comptes.medecin.id], 'médecin de l’établissement notifié');
  assert.equal(rouge.corps.partogramme.dilatation.zoneActuelle, 'Rouge');

  const dossier = await appel('medecin', 'GET', `/accouchements/${dossierId}`);
  assert.equal(dossier.corps.surveillances[0].tempsDepuis.arriveeH, 1);
  assert.equal(dossier.corps.surveillances[0].tempsDepuis.ruptureH, 2);
  assert.equal(dossier.corps.surveillances[0].tempsDepuis.debutTravailH, 3);
  // Examen d'entrée (BCF 140, effacement 50 %) en premier point, puis les 5 surveillances.
  assert.equal(dossier.corps.partogramme.bcf.points.length, 6);
  assert.deepEqual([dossier.corps.partogramme.bcf.points[0].bcf, dossier.corps.partogramme.bcf.points[0].id], [140, 'examen-entree']);
  // Effacement du col : courbe propre, heures comptées depuis le début de la phase active.
  const effacement = dossier.corps.partogramme.effacement.points;
  assert.deepEqual([effacement[0].pct, effacement[0].phase], [50, 'Latence']);
  assert.deepEqual(effacement.slice(1).map((x) => [x.pct, x.phase, x.heures]), [[30, 'Latence', -1], [70, 'Active', 2]]);
  assert.equal(dossier.corps.surveillances[0].effacementPct, 30);
  assert.equal((await saisir({ effacementPct: 120 })).status, 400, 'effacement entre 0 et 100 %');

  const alertes = await appel('medecin', 'GET', '/accouchements/alertes');
  assert.equal(alertes.corps.length, 5);
  const ack = await appel('medecin', 'POST', `/accouchements/${dossierId}/alertes/${alerteRouge.id}/acquitter`);
  assert.equal(ack.status, 200);
  assert.equal(ack.corps.acquitteePar.id, comptes.medecin.id);
  assert.equal((await appel('medecin', 'GET', '/accouchements/alertes')).corps.length, 4);

  const salle = await appel('sageFemme', 'GET', '/accouchements');
  assert.equal(salle.corps[0].zoneActuelle, 'Rouge');
  assert.match(salle.corps[0].patiente.photoUrl, /^https:\/\/signe\.invalid\//, 'photo par lien signé');
  assert.ok(!('photoCle' in salle.corps[0].patiente), 'clé de stockage jamais exposée');
  assert.equal(salle.corps[0].alertesCritiques, 3);
});

test('accouchement + nouveau-né : grossesse terminée, dossier de l’enfant rattaché à la mère, vaccination programmée', async () => {
  const sansIndication = await appel('medecin', 'PUT', `/accouchements/${dossierId}/accouchement`, { mode: 'Césarienne', heure: ilYaH(2) });
  assert.equal(sansIndication.status, 400);

  const r = await appel('medecin', 'PUT', `/accouchements/${dossierId}/accouchement`, {
    mode: 'Normal', heure: ilYaH(2), multiple: false, nombreEnfants: 1, episiotomie: false, dechirure: { presente: true, degre: 1 },
    assiste: 'Sarah SAGEFEMME',
    delivrance: { ocytocine10UI: { administree: true, heure: ilYaH(1.95) }, tractionControlee: true, massageUterin: true, mode: 'Spontanée', heure: ilYaH(1.9), placenta: { complet: true }, membranesCompletes: true, pertesSangMl: 650 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.equal(r.corps.statut, 'Post-partum');
  assert.equal(r.corps.accouchement.delivrance.hemorragie, 'Pathologique', '650 ml > 500 ml');
  assert.equal(r.corps.accouchement.accoucheur, 'Marie MEDECIN');
  assert.equal(r.corps.planningPostPartum.length, 16, '4 + 4 + 2 créneaux, 4e-6e heure, J1-J3');

  // Nouveau-né : photo obligatoire pour une naissance vivante.
  const bebe = {
    prenom: 'Joie', sexe: 'Féminin',
    naissance: {
      senn: { maintienTemperature: true, temperatureAxillaire: 36.8, crede: true }, soinsCordon: { lameSterile: true, filSterile: true },
      miseAuSeinMoins1h: true, poidsG: 3200, tailleCm: 50, perimetreCranienCm: 34,
      apgar: { m1: { respiration: 2, fc: 2, coloration: 1, reflexes: 2, tonus: 1 }, m5: { respiration: 2, fc: 2, coloration: 2, reflexes: 2, tonus: 2 } },
      reanimation: { faite: false }, traitement: { vitamineK1: true },
    },
  };
  const sansPhoto = await ajouterNouveauNe('medecin', dossierId, bebe, { sansPhoto: true });
  assert.equal(sansPhoto.status, 400);
  assert.match(sansPhoto.corps.message, /photo du nouveau-né est obligatoire/);
  const n = await ajouterNouveauNe('medecin', dossierId, bebe);
  assert.equal(n.status, 201, JSON.stringify(n.corps));
  assert.match(n.corps.photoUrl, /^https:\/\/signe\.invalid\/enfant\//, 'photo servie par lien signé');
  assert.equal(n.corps.photoCle, undefined, 'clé R2 jamais exposée');
  enfantId = n.corps.id;
  const dossier = await appel('sageFemme', 'GET', `/accouchements/${dossierId}`);
  assert.equal(dossier.corps.nouveauNes.length, 1);
  assert.ok(dossier.corps.nouveauNes[0].photoUrl, 'photo dans la liste des nouveau-nés');

  // Remplacement de la photo : médecins et sages-femmes seulement.
  const photo = new FormData();
  photo.append('photo', new Blob([PNG], { type: 'image/png' }), 'bebe2.png');
  const refusPhoto = await fetch(`${api}/enfants/${enfantId}/photo`, { method: 'PUT', headers: { Authorization: `Bearer ${jetons.infirmiere}` }, body: photo });
  assert.equal(refusPhoto.status, 403);
  const changee = await fetch(`${api}/enfants/${enfantId}/photo`, { method: 'PUT', headers: { Authorization: `Bearer ${jetons.sageFemme}` }, body: photo });
  assert.equal(changee.status, 200);

  // Après l'accouchement : saisie rétroactive seulement (heure obligatoire, avant la naissance, sans alerte).
  const surv = (corps) => appel('sageFemme', 'POST', `/accouchements/${dossierId}/surveillances`, corps);
  assert.equal((await surv({ bcf: 140 })).status, 400, 'heure obligatoire');
  assert.equal((await surv({ le: ilYaH(1), bcf: 140 })).status, 409, 'plus de partogramme après la naissance');
  const retro = await surv({ le: ilYaH(2.2), bcf: 100 });
  assert.equal(retro.status, 201, JSON.stringify(retro.corps));
  assert.equal(retro.corps.alertes.length, 0, 'pas d’alerte pour une mesure passée');
  assert.ok(retro.corps.partogramme.bcf.points.some((x) => x.bcf === 100));

  const enfant = await appel('infirmiere', 'GET', `/enfants/${enfantId}`);
  assert.equal(enfant.status, 200);
  assert.equal(enfant.corps.naissance.apgar.m1.total, 8);
  assert.equal(enfant.corps.naissance.apgar.m5.total, 10);
  assert.equal(enfant.corps.nom, 'KABILA', 'nom de la mère par défaut');
  assert.equal(enfant.corps.mere.numero, patiente.numero);
  assert.deepEqual(enfant.corps.carnet.prochaineSeance.doses.map((d) => d.code), ['bcg', 'vpo0']);
  assert.equal(enfant.corps.rendezVous.length, 1, 'séance de vaccination programmée');
  assert.equal(enfant.corps.rendezVous[0].patienteId, patiente.id, 'rendez-vous au nom de la mère');

  const mere = await appel('medecin', 'GET', `/patientes/${patiente.id}`);
  assert.equal(mere.corps.patiente.statut, 'Suivi postnatal');
  assert.equal(mere.corps.grossesses[0].statut, 'Terminée');
  assert.equal(mere.corps.grossesses[0].issue.issue, 'Naissance vivante');
  assert.equal(mere.corps.grossesses[0].issue.mode, 'Voie basse');
  assert.equal(mere.corps.enfants.length, 1);
  assert.equal(mere.corps.accouchements[0].mode, 'Normal');

  const refusNaissance = await appel('infirmiere', 'PATCH', `/enfants/${enfantId}`, { naissance: { poidsG: 3000 } });
  assert.equal(refusNaissance.status, 403, 'données de naissance : médecins et sages-femmes');
});

test('post-partum, sortie et clôture : mesures préventives obligatoires, BCG/VPO reportés au carnet', async () => {
  const pp = await appel('sageFemme', 'POST', `/accouchements/${dossierId}/post-partum/surveillances`, {
    creneau: 'H1-15', le: ilYaH(1.75),
    mere: { taSystolique: 115, taDiastolique: 75, pouls: 84, temperature: 37, saignement: '+', globeSecurite: true, conscience: 'Consciente' },
    nouveauNes: [{ enfantId, respiration: 48, coloration: 'Rose', temperatureAxillaire: 36.9 }],
  });
  assert.equal(pp.status, 201, JSON.stringify(pp.corps));
  assert.equal(pp.corps.planningPostPartum[0].statut, 'Faite');
  assert.equal((await appel('sageFemme', 'POST', `/accouchements/${dossierId}/post-partum/surveillances`, { creneau: 'H1-15', mere: { pouls: 80 } })).status, 409);

  const t = await appel('sageFemme', 'POST', `/accouchements/${dossierId}/post-partum/traitements`, { pour: 'Mère', produit: 'Fer/acide folique', dose: '1 cp/j' });
  assert.equal(t.status, 201);
  const tId = t.corps.postPartum.traitements[0].id;
  const adm = await appel('sageFemme', 'POST', `/accouchements/${dossierId}/post-partum/traitements/${tId}/administrer`);
  assert.equal(adm.corps.postPartum.traitements[0].statut, 'Administré');

  const incomplet = await appel('medecin', 'POST', `/accouchements/${dossierId}/cloturer`);
  assert.equal(incomplet.status, 400);
  assert.ok(incomplet.corps.manquants.includes('Examen de sortie'));
  assert.ok(incomplet.corps.manquants.includes('Mesure préventive mère : Fer / folate'));

  const rdvCpon = new Date(Date.now() + 6 * 86400000);
  rdvCpon.setUTCHours(8, 0, 0, 0);
  const sortie = await appel('medecin', 'PUT', `/accouchements/${dossierId}/sortie`, {
    date: new Date(Date.now() + 3600000).toISOString().slice(0, 10), rdvCpon: rdvCpon.toISOString(), observations: 'Bon état général',
    conseils: 'Allaitement exclusif, signes de danger expliqués.',
    mesuresPreventives: {
      mere: { ferFolate: true, mebendazole: true, sp: false, mild: true, vat: true, vitamineA: true, rpr: true, arv: false },
      nouveauNe: { bcgVpo: true, rpr: false, prophylaxieTb: false, mild: true, antibiotique: false, arvProphylaxie: false },
    },
  });
  assert.equal(sortie.status, 200, JSON.stringify(sortie.corps));
  assert.deepEqual(sortie.corps.manquantsCloture, ['Mesure préventive mère : TB']);
  const complete = await appel('medecin', 'PUT', `/accouchements/${dossierId}/sortie`, { mesuresPreventives: { mere: { tb: false } } });
  assert.deepEqual(complete.corps.manquantsCloture, [], 'mise à jour partielle : les réponses déjà cochées sont conservées');

  const close = await appel('medecin', 'POST', `/accouchements/${dossierId}/cloturer`);
  assert.equal(close.status, 200, JSON.stringify(close.corps));
  assert.equal(close.corps.statut, 'Clôturé');
  assert.equal((await appel('medecin', 'PUT', `/accouchements/${dossierId}/sortie`, { conseils: 'x' })).status, 409, 'dossier clôturé');

  const enfant = await appel('infirmiere', 'GET', `/enfants/${enfantId}`);
  const statut = (code) => enfant.corps.carnet.doses.find((d) => d.code === code).statut;
  assert.equal(statut('bcg'), 'Faite');
  assert.equal(statut('vpo0'), 'Faite');
  const attendus = enfant.corps.rendezVous.filter((r) => ['Planifié', 'Confirmé', 'Reporté'].includes(r.statut));
  assert.equal(attendus.length, 1, 'séance de naissance honorée, séance des 6 semaines programmée');
  assert.match(attendus[0].motif, /DTC-HepB-Hib 1/);
  assert.equal(attendus[0].date.slice(0, 10), enfant.corps.carnet.prochaineSeance.date);
  assert.equal(enfant.corps.rendezVous.filter((r) => r.statut === 'Effectué').length, 1);
});

test('vaccination par une infirmière : doublon refusé, annulation motivée', async () => {
  const doublon = await appel('infirmiere', 'POST', `/enfants/${enfantId}/vaccinations`, { code: 'bcg' });
  assert.equal(doublon.status, 409);
  const futur = await appel('infirmiere', 'POST', `/enfants/${enfantId}/vaccinations`, { code: 'penta1', date: '2999-01-01' });
  assert.equal(futur.status, 400);
  const v = await appel('infirmiere', 'POST', `/enfants/${enfantId}/vaccinations`, { doses: [{ code: 'penta1', lot: 'L123' }, { code: 'vpo1' }] });
  assert.equal(v.status, 201, JSON.stringify(v.corps));
  const penta = v.corps.vaccinations.find((x) => x.code === 'penta1');
  assert.equal(penta.administreePar.id, comptes.infirmiere.id);
  const annule = await appel('infirmiere', 'POST', `/enfants/${enfantId}/vaccinations/${penta.id}/annuler`, { motif: 'Saisie sur le mauvais enfant' });
  assert.equal(annule.status, 200);
  assert.notEqual(annule.corps.carnet.doses.find((d) => d.code === 'penta1').statut, 'Faite');
  assert.equal(annule.corps.vaccinations.length, 4, 'la saisie annulée reste visible');

  const suivi = await appel('infirmiere', 'POST', `/enfants/${enfantId}/suivis`, { poidsG: 3400, tailleCm: 51, alimentation: 'Allaitement exclusif' });
  assert.equal(suivi.status, 201);
});

test('espace patiente : connexion, accueil, carnet du bébé et rendez-vous ; cloisonnement des jetons', async () => {
  const mauvais = await appel(null, 'POST', '/espace-patiente/connexion', { email: 'esther@essai.test', motDePasse: 'faux' });
  assert.equal(mauvais.status, 401);
  const c = await appel(null, 'POST', '/espace-patiente/connexion', { email: 'ESTHER@essai.test', motDePasse: 'Bebe2026ok' });
  assert.equal(c.status, 200, JSON.stringify(c.corps));
  const jeton = c.corps.jeton;
  assert.equal(c.corps.patiente.numero, patiente.numero);

  // Téléphone pour les notifications push : un jeton n'est gardé qu'une fois, et jamais exposé.
  const PatienteM = require('../models/Patiente');
  assert.equal((await appel(jeton, 'POST', '/espace-patiente/appareils', {})).status, 400);
  assert.equal((await appel(jeton, 'POST', '/espace-patiente/appareils', { jeton: 'fcm-1', plateforme: 'android' })).status, 204);
  await appel(jeton, 'POST', '/espace-patiente/appareils', { jeton: 'fcm-1', plateforme: 'android' });
  await appel(jeton, 'POST', '/espace-patiente/appareils', { jeton: 'fcm-2', plateforme: 'ios' });
  assert.deepEqual((await PatienteM.findById(patiente.id).select('+appareils')).appareils.map((a) => a.jeton), ['fcm-1', 'fcm-2']);
  assert.equal((await appel(jeton, 'DELETE', '/espace-patiente/appareils', { jeton: 'fcm-1' })).status, 204);
  assert.deepEqual((await PatienteM.findById(patiente.id).select('+appareils')).appareils.map((a) => a.jeton), ['fcm-2']);
  assert.equal((await appel(jeton, 'GET', '/espace-patiente/moi')).corps.appareils, undefined);
  await PatienteM.updateOne({ _id: patiente.id }, { appareils: [] });

  const accueil = await appel(jeton, 'GET', '/espace-patiente/accueil');
  assert.equal(accueil.status, 200);
  assert.equal(accueil.corps.enfants[0].prenom, 'Joie');
  assert.ok(accueil.corps.enfants[0].vaccination.prochaineSeance);
  const motifs = accueil.corps.prochainsRendezVous.map((r) => r.motif);
  assert.ok(motifs.includes('Consultation postnatale (CPoN)'), 'RDV de la mère');
  assert.ok(accueil.corps.prochainsRendezVous.some((r) => r.enfant?.prenom === 'Joie'), 'RDV du bébé');

  // Ma grossesse : datation (DDR, DPA), fiches CPN finalisées (pas le brouillon), RDV de suivi.
  const Grossesse = require('../models/Grossesse');
  const Consultation = require('../models/Consultation');
  const gE = await Grossesse.findOne({ patienteId: patiente.id }).sort({ numero: -1 });
  const baseC = { patienteId: gE.patienteId, grossesseId: gE._id, type: 'Suivi prénatal', statut: 'Finalisée', auteur: { id: comptes.medecin.id, nom: 'Marie MEDECIN', role: 'Médecin' } };
  await Consultation.create({
    ...baseC, date: new Date(Date.now() - 40 * 86400000), laboratoire: { hb: '9,1' },
    mesuresPreventives: { resultatTest: { reponse: true, valeur: 'négatif' }, dcip: { reponse: true }, mild: { reponse: true } },
  });
  await Consultation.create({
    ...baseC, date: new Date(Date.now() - 10 * 86400000), evaluation: 'Note interne du médecin',
    constantes: { poidsKg: 72, taSystolique: 130, taDiastolique: 85 }, examenCpn: { presentation: 'Siège' },
  });
  await Consultation.create({ ...baseC, date: new Date(), statut: 'Brouillon' });
  const g = await appel(jeton, 'GET', '/espace-patiente/grossesse');
  assert.equal(g.status, 200, JSON.stringify(g.corps));
  assert.equal(g.corps.grossesse.datation.methode, 'DDR');
  assert.match(g.corps.grossesse.datation.ddr, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(g.corps.grossesse.datation.dpa);
  assert.equal(g.corps.consultations.length, 2, 'brouillon exclu');
  const [recente, ancienne] = g.corps.consultations;
  assert.equal(recente.constantes.poidsKg, 72);
  assert.equal(recente.constantes.taSystolique, 130);
  assert.equal(recente.examen.presentation, 'Siège');
  assert.deepEqual(ancienne.laboratoire, [{ libelle: 'Hb (g/dl)', resultat: '9,1' }]);
  assert.deepEqual(ancienne.mesuresPreventives.map((m) => m.libelle), ['Dort sous MILD'], 'PTME non affiché');
  assert.ok(!('evaluation' in recente) && !('facteursRisque' in recente), 'notes du médecin non exposées');
  assert.ok(g.corps.rendezVous.every((r) => r.enfant === null), 'RDV de la mère seulement');

  const enfants = await appel(jeton, 'GET', '/espace-patiente/enfants');
  const bebe = enfants.corps[0];
  assert.equal(bebe.naissance.poidsG, 3200);
  assert.equal(bebe.carnet.doses.find((d) => d.code === 'bcg').statut, 'Faite');
  assert.equal(bebe.croissance.length, 1);
  assert.ok(!('administreePar' in bebe.carnet.doses[0]), 'pas d’identifiant de soignant');

  const accouchements = await appel(jeton, 'GET', '/espace-patiente/accouchements');
  assert.equal(accouchements.corps[0].mode, 'Normal');
  assert.ok(accouchements.corps[0].mesuresPreventives.nouveauNe.includes('BCG / VPO'));
  const vu = accouchements.corps[0];
  assert.ok(vu.examen && vu.examen.le, 'examen clinique d’entrée visible');
  assert.ok(vu.travail.some((m) => m.bcf != null), 'BCF du travail visibles');
  assert.ok(vu.travail.some((m) => m.dilatationCm != null), 'dilatations du travail visibles');
  assert.ok(vu.travail.every((m, i, l) => !i || new Date(l[i - 1].le) >= new Date(m.le)), 'du plus récent au plus ancien');
  assert.ok(vu.postPartum.length >= 1, 'contrôles post-partum visibles');
  assert.ok(!('alertes' in vu) && !('surveillances' in vu), 'alertes internes non exposées');
  assert.ok(!JSON.stringify(vu).includes(comptes.medecin.id), 'pas d’identifiant de soignant');

  // Carte patiente : même PDF que celui du médecin, ouvert par un lien temporaire.
  const enTetes = { Authorization: `Bearer ${jetons[jeton] ?? jeton}` };
  const carteDirecte = await fetch(`${api}/espace-patiente/carte`, { headers: enTetes });
  assert.equal(carteDirecte.status, 200);
  assert.equal(carteDirecte.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await carteDirecte.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  const apercu = await appel(jeton, 'GET', '/espace-patiente/carte/apercu');
  assert.equal(apercu.status, 200, JSON.stringify(apercu.corps));
  assert.match(apercu.corps.qr, /^data:image\/png;base64,/, 'QR code identique au PDF');
  assert.match(apercu.corps.numero, /^AC-PAT-/);
  assert.ok(apercu.corps.delivreeLe && apercu.corps.delivreePar);
  const lien = await appel(jeton, 'POST', '/espace-patiente/carte/lien');
  assert.equal(lien.status, 200, JSON.stringify(lien.corps));
  const parLien = await fetch(`${api}${lien.corps.chemin}`);
  assert.equal(parLien.status, 200);
  assert.equal(Buffer.from(await parLien.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  assert.equal((await fetch(`${api}/espace-patiente/carte.pdf?jeton=faux`)).status, 401);
  // QR code : même domaine que l'espace admin (mémorisé à la connexion d'un soignant, localhost ignoré).
  const domaine = require('../config/domaineAdmin');
  const appUrl = process.env.APP_URL;
  delete process.env.APP_URL;
  await domaine.memoriser('https://admin.ami-sante.test/admin/accueil');
  await domaine.memoriser('http://localhost:4200');
  assert.equal(await domaine.domaineAdmin(), 'https://admin.ami-sante.test');
  process.env.APP_URL = 'https://tableau.ami-sante.test';
  assert.equal(await domaine.domaineAdmin(), 'https://tableau.ami-sante.test', 'APP_URL configurée prioritaire');
  if (appUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = appUrl;
  const jetonSession = enTetes.Authorization.split(' ')[1];
  assert.equal((await fetch(`${api}/espace-patiente/carte.pdf?jeton=${jetonSession}`)).status, 401, 'jeton de session refusé dans un lien');

  // Conseils : ceux de la sortie de maternité, et les articles approuvés seulement.
  const Article = require('../models/Article');
  const auteurArticle = { id: comptes.medecin.id, nom: 'Marie MEDECIN', role: 'Médecin' };
  await Article.create({ titre: 'Allaiter sans douleur', contenu: 'Conseils…', cible: 'Après l’accouchement', auteur: auteurArticle, statut: 'Approuvé' });
  await Article.create({ titre: 'Brouillon', contenu: 'Pas encore relu', auteur: auteurArticle, statut: 'En attente' });
  const conseils = await appel(jeton, 'GET', '/espace-patiente/conseils');
  assert.equal(conseils.status, 200, JSON.stringify(conseils.corps));
  assert.ok(conseils.corps.personnels.some((c) => c.origine === 'Accouchement' && /Allaitement exclusif/.test(c.texte)));
  assert.deepEqual(conseils.corps.articles.map((a) => a.titre), ['Allaiter sans douleur'], 'article en attente invisible');
  const article = conseils.corps.articles[0];
  assert.ok(!('jaimes' in article), 'liste des j’aime non exposée');
  assert.ok(!('id' in article.auteur), 'pas d’identifiant de soignant');
  assert.equal(article.nbJaimes, 0);

  // J'aime (bascule) et commentaires de la patiente ; réponse du médecin auteur.
  const aime = await appel(jeton, 'POST', `/espace-patiente/conseils/articles/${article.id}/jaime`);
  assert.equal(aime.status, 200, JSON.stringify(aime.corps));
  assert.deepEqual([aime.corps.jAime, aime.corps.nbJaimes], [true, 1]);
  assert.equal((await appel(jeton, 'POST', `/espace-patiente/conseils/articles/${article.id}/jaime`)).corps.nbJaimes, 0);
  assert.equal((await appel(jeton, 'POST', `/espace-patiente/conseils/articles/${article.id}/commentaires`, { texte: ' ' })).status, 400);
  const com = await appel(jeton, 'POST', `/espace-patiente/conseils/articles/${article.id}/commentaires`, { texte: 'Merci docteur !' });
  assert.equal(com.status, 201, JSON.stringify(com.corps));
  const monCom = com.corps.commentaires[0];
  assert.equal(monCom.auteur.moi, true);
  const enAttente = await Article.findOne({ statut: 'En attente' });
  assert.equal((await appel(jeton, 'POST', `/espace-patiente/conseils/articles/${enAttente.id}/jaime`)).status, 404, 'article en attente');

  // Côté soignants (ami-sante) : le commentaire apparaît, le médecin auteur y répond.
  const cote = await appel('medecin', 'GET', `/articles/${article.id}`);
  assert.equal(cote.corps.commentaires[0].auteur.role, 'Patiente');
  assert.equal((await appel('medecin', 'POST', `/articles/${article.id}/commentaires/${monCom.id}/reponses`, { texte: 'Avec plaisir.' })).status, 201);

  // Autre patiente : l'enfant d'Esther lui est invisible.
  const autre = await creerPatiente({ patiente: { nom: 'Autre', prenom: 'Mère', ageDeclare: 30, email: 'autre@essai.test', adresse: { province: 'Kinshasa' } }, compte: { motDePasse: 'Autre2026ok' } });
  assert.equal(autre.status, 201);
  const jetonAutre = (await appel(null, 'POST', '/espace-patiente/connexion', { email: 'autre@essai.test', motDePasse: 'Autre2026ok' })).corps.jeton;
  assert.equal((await appel(jetonAutre, 'GET', `/espace-patiente/enfants/${enfantId}`)).status, 404);

  // L'autre patiente voit le commentaire d'Esther abrégé, sans photo, et ne peut pas le supprimer.
  const vuParAutre = (await appel(jetonAutre, 'GET', '/espace-patiente/conseils')).corps.articles[0];
  const comEsther = vuParAutre.commentaires[0];
  assert.match(comEsther.auteur.nom, /^\S+ [A-Z]\.$/, 'nom abrégé');
  assert.equal(comEsther.auteur.photoUrl, null);
  assert.equal(comEsther.auteur.moi, false);
  assert.equal(comEsther.reponses[0].auteur.role, 'Médecin');
  assert.equal((await appel(jetonAutre, 'DELETE', `/espace-patiente/conseils/articles/${vuParAutre.id}/commentaires/${comEsther.id}`)).status, 403);
  assert.equal((await appel(jeton, 'DELETE', `/espace-patiente/conseils/articles/${vuParAutre.id}/commentaires/${comEsther.id}`)).status, 200);
  assert.equal((await appel(jeton, 'GET', `/espace-patiente/enfants/${enfantId}`)).status, 200);

  assert.equal((await appel(jeton, 'GET', `/patientes/${patiente.id}`)).status, 403, 'jeton patiente refusé côté personnel');
  assert.equal((await appel(jeton, 'GET', `/enfants/${enfantId}`)).status, 403);
  assert.equal((await appel('medecin', 'GET', '/espace-patiente/accueil')).status, 403, 'jeton soignant refusé côté patiente');
});

test('suppression d’un dossier d’accouchement : médecins seulement, numéro retapé, bébés supprimés, grossesse rouverte', async () => {
  const r = await creerPatiente({ patiente: { nom: 'Suppr', prenom: 'Essai', ageDeclare: 26, email: 'suppr@essai.test', adresse: { province: 'Kinshasa' } }, compte: { motDePasse: 'Suppr2026ok' } });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  const a = await appel('sageFemme', 'POST', '/accouchements', { patienteId: r.corps.id, admission: { admiseLe: ilYaH(5) } });
  assert.equal(a.status, 201);
  const acc = await appel('medecin', 'PUT', `/accouchements/${a.corps.id}/accouchement`, { mode: 'Normal', heure: ilYaH(1) });
  assert.equal(acc.status, 200, JSON.stringify(acc.corps));
  const bebe = (await ajouterNouveauNe('medecin', a.corps.id, { prenom: 'Temp', sexe: 'Masculin' })).corps;
  assert.equal((await appel('medecin', 'GET', `/patientes/${r.corps.id}`)).corps.grossesses[0].statut, 'Terminée');

  assert.equal((await appel('sageFemme', 'DELETE', `/accouchements/${a.corps.id}`, { confirmation: a.corps.numero })).status, 403, 'sage-femme refusée');
  assert.equal((await appel('medecin', 'DELETE', `/accouchements/${a.corps.id}`, { confirmation: 'AC-ACC-999999' })).status, 400, 'numéro à retaper');
  const suppr = await appel('medecin', 'DELETE', `/accouchements/${a.corps.id}`, { confirmation: a.corps.numero });
  assert.equal(suppr.status, 204);

  assert.equal((await appel('medecin', 'GET', `/accouchements/${a.corps.id}`)).status, 404);
  assert.equal((await appel('medecin', 'GET', `/enfants/${bebe.id}`)).status, 404, 'dossier du bébé supprimé');
  const mere = await appel('medecin', 'GET', `/patientes/${r.corps.id}`);
  assert.equal(mere.corps.grossesses[0].statut, 'En cours', 'grossesse rouverte');
  assert.equal(mere.corps.grossesses[0].issue, undefined);
  assert.equal(mere.corps.patiente.statut, 'Suivi prénatal');
  assert.equal(mere.corps.accouchements.length, 0);
  assert.equal(mere.corps.rendezVous.filter((x) => x.enfantId).length, 0, 'RDV du bébé supprimés');
  // Nouvelle admission possible pour cette grossesse.
  assert.equal((await appel('sageFemme', 'POST', '/accouchements', { patienteId: r.corps.id })).status, 201);
});


test('admission directe : femme venue accoucher sans dossier ni CPN, dossier et compte patiente créés, doublons signalés', async () => {
  const nouvelle = {
    nom: 'Mbuyi', prenom: 'Grâce', ageDeclare: 24, telephone: '+243 99 555 6677', email: 'grace@essai.test',
    adresse: { commune: 'Ngaliema', quartier: 'Binza' }, contactUrgence: { nom: 'Paul Mbuyi', lien: 'Mari', telephone: '+243 99 000 1111' },
  };
  const compte = { motDePasse: 'Bebe2026ok' };
  const admettre = (corps, options) => admissionDirecte('sageFemme', { compte, ...corps }, options);
  assert.equal((await admissionDirecte('infirmiere', { nouvellePatiente: nouvelle, compte })).status, 403, 'infirmière refusée');
  const sansPhoto = await admettre({ nouvellePatiente: nouvelle }, { sansPhoto: true });
  assert.equal(sansPhoto.status, 400, 'photo obligatoire');
  assert.match(sansPhoto.corps.message, /photo/i);
  assert.equal((await admettre({ nouvellePatiente: { ...nouvelle, nom: '' } })).status, 400, 'nom obligatoire');
  assert.equal((await admettre({ nouvellePatiente: { ...nouvelle, ageDeclare: null } })).status, 400, 'âge obligatoire');
  assert.equal((await admettre({ nouvellePatiente: { ...nouvelle, email: 'pas-un-email' } })).status, 400, 'e-mail obligatoire et valide');
  assert.equal((await admettre({ nouvellePatiente: nouvelle, compte: { motDePasse: 'court' } })).status, 400, 'mot de passe robuste');

  const a = await admettre({ nouvellePatiente: nouvelle, admission: { admiseLe: ilYaH(1), motif: 'Contractions', provenance: 'AS' } });
  assert.equal(a.status, 201, JSON.stringify(a.corps));
  assert.equal(a.corps.admission.nom, 'MBUYI');
  assert.equal(a.corps.admission.personneAPrevenir.nom, 'Paul Mbuyi');
  const mere = await appel('medecin', 'GET', `/patientes/${a.corps.patiente.id}`);
  assert.equal(mere.status, 200);
  assert.equal(mere.corps.patiente.enregistreeVia, 'Admission directe');
  assert.ok(mere.corps.patiente.photoUrl, 'photo d’identification enregistrée');
  assert.equal(mere.corps.patiente.motDePasse, undefined, 'mot de passe jamais renvoyé');
  assert.equal(mere.corps.grossesses.length, 1, 'grossesse ouverte à l’admission');

  // Application patiente : elle se connecte avec l'e-mail et le mot de passe choisis à l'admission.
  const c = await appel(null, 'POST', '/espace-patiente/connexion', { email: 'grace@essai.test', motDePasse: 'Bebe2026ok' });
  assert.equal(c.status, 200, JSON.stringify(c.corps));
  assert.equal(c.corps.patiente.numero, mere.corps.patiente.numero);

  // Même femme revenue (même e-mail, ou même identité) : son dossier existant est proposé.
  const memeEmail = await admettre({ nouvellePatiente: nouvelle });
  assert.equal(memeEmail.status, 409);
  assert.equal(memeEmail.corps.emailExistant, true);
  assert.equal(memeEmail.corps.doublons[0].numero, mere.corps.patiente.numero);
  const doublon = await admettre({ nouvellePatiente: { ...nouvelle, email: 'grace2@essai.test' } });
  assert.equal(doublon.status, 409);
  assert.equal(doublon.corps.doublons[0].numero, mere.corps.patiente.numero);
  // Homonyme confirmée par le soignant : nouveau dossier.
  const homonyme = await admettre({ nouvellePatiente: { ...nouvelle, telephone: '', email: 'grace2@essai.test' }, confirmerMalgreDoublons: true });
  assert.equal(homonyme.status, 201, JSON.stringify(homonyme.corps));
  assert.notEqual(homonyme.corps.patiente.id, a.corps.patiente.id);
});

test('partogramme : BCF, dilatation et effacement de l’examen clinique d’entrée tracés en premier point', async () => {
  const a = await admissionDirecte('sageFemme', {
    nouvellePatiente: { nom: 'Ilunga', prenom: 'Sarah', ageDeclare: 27, email: 'sarah@essai.test' }, compte: { motDePasse: 'Bebe2026ok' },
    admission: { admiseLe: ilYaH(3) },
  });
  assert.equal(a.status, 201, JSON.stringify(a.corps));
  assert.equal(a.corps.partogramme.bcf.points.length, 0, 'rien avant l’examen');

  const ex = await appel('sageFemme', 'PUT', `/accouchements/${a.corps.id}/examen-clinique`, {
    examineLe: ilYaH(2.5), obstetrical: { bcf: 150, toucherVaginal: { effacementPct: 80, dilatationCm: 5 } },
  });
  assert.equal(ex.status, 200, JSON.stringify(ex.corps));
  const p = ex.corps.partogramme;
  assert.equal(p.bcf.points.length, 1);
  assert.equal(p.bcf.points[0].bcf, 150);
  assert.equal(p.effacement.points[0].pct, 80);
  assert.ok(p.debutPhaseActive, 'dilatation ≥ 4 cm à l’entrée : phase active commencée');
  assert.deepEqual(p.dilatation.points.map((x) => [x.heures, x.cm]), [[0, 5]]);

  // La surveillance suivante se trace à la suite, sur la même phase active.
  const s = await appel('sageFemme', 'POST', `/accouchements/${a.corps.id}/surveillances`, { le: ilYaH(0.5), bcf: 145, dilatationCm: 7 });
  assert.equal(s.status, 201, JSON.stringify(s.corps));
  assert.equal(s.corps.surveillance.phase, 'Active');
  assert.deepEqual(s.corps.partogramme.dilatation.points.map((x) => x.cm), [5, 7]);
  assert.deepEqual(s.corps.partogramme.bcf.points.map((x) => x.bcf), [150, 145]);
});
test('examen clinique d’entrée : plusieurs relevés BCF / dilatation à des heures différentes, tous tracés', async () => {
  const a = await admissionDirecte('sageFemme', {
    nouvellePatiente: { nom: 'Kabeya', prenom: 'Rachel', ageDeclare: 31, email: 'rachel@essai.test' }, compte: { motDePasse: 'Bebe2026ok' }, confirmerMalgreDoublons: true,
    admission: { admiseLe: ilYaH(5) },
  });
  assert.equal(a.status, 201, JSON.stringify(a.corps));
  const url = `/accouchements/${a.corps.id}/examen-clinique`;

  // Relevés envoyés dans le désordre, une ligne vide ignorée.
  const ex = await appel('sageFemme', 'PUT', url, {
    examineLe: ilYaH(4.5),
    obstetrical: {
      toucherVaginal: { effacementPct: 60 },
      releves: [
        { le: ilYaH(2.5), bcf: 138, dilatationCm: 5 },
        { le: ilYaH(4.5), bcf: 150, dilatationCm: 3 },
        { le: ilYaH(3.5), bcf: 112 },
        { le: ilYaH(3), bcf: null, dilatationCm: null },
      ],
    },
  });
  assert.equal(ex.status, 200, JSON.stringify(ex.corps));
  const o = ex.corps.examenClinique.obstetrical;
  assert.deepEqual(o.releves.map((r) => r.bcf), [150, 112, 138], 'triés par heure, ligne vide retirée');
  assert.deepEqual([o.bcf, o.toucherVaginal.dilatationCm], [138, 5], 'champs uniques = dernier relevé');
  const p = ex.corps.partogramme;
  assert.deepEqual(p.bcf.points.map((x) => x.bcf), [150, 112, 138]);
  assert.deepEqual(p.dilatation.points.map((x) => [x.heures, x.cm]), [[0, 5]], 'phase active à partir du relevé à 5 cm');
  assert.equal(p.effacement.points.length, 1);

  // Heure manquante ou dans le futur : refus.
  const sansHeure = await appel('sageFemme', 'PUT', url, { obstetrical: { releves: [{ bcf: 140 }] } });
  assert.equal(sansHeure.status, 400);
  const futur = await appel('sageFemme', 'PUT', url, { obstetrical: { releves: [{ le: new Date(Date.now() + 3 * 3600000).toISOString(), bcf: 140 }] } });
  assert.equal(futur.status, 400);
});

test('enfant né hors plateforme (mère sans CPN ni accouchement ici) : enregistré pour la vaccination, doses du carnet reprises', async () => {
  const neLe = ilYaJ(70); // 10 semaines
  const enfant = { prenom: 'Divine', sexe: 'Féminin', dateNaissance: neLe, lieuNaissance: 'CS Fictif de Lemba', naissance: { poidsG: 3100 } };
  const mere = { nom: 'Tshala', prenom: 'Ruth', ageDeclare: 29, email: 'ruth.tshala@essai.test', telephone: '+243 85 777 0011' };
  const compte = { motDePasse: 'Vaccin2026ok' };
  const anterieures = [{ code: 'bcg', date: neLe, lieu: 'CS Fictif de Lemba' }, { code: 'vpo0', date: neLe }];

  // Contrôles : photos obligatoires, mère obligatoire, dates.
  assert.equal((await enregistrerEnfant('infirmiere', { enfant, nouvelleMere: mere, compte }, { photo: false, photoMere: true })).status, 400, 'photo de l’enfant obligatoire');
  const sansPhotoMere = await enregistrerEnfant('infirmiere', { enfant, nouvelleMere: mere, compte });
  assert.equal(sansPhotoMere.status, 400, 'photo de la mère obligatoire');
  assert.match(sansPhotoMere.corps.message, /photo de la mère/);
  assert.equal((await enregistrerEnfant('infirmiere', { enfant })).status, 400, 'mère obligatoire');
  assert.equal((await enregistrerEnfant('infirmiere', { enfant: { ...enfant, dateNaissance: ilYaJ(-2) }, nouvelleMere: mere, compte }, { photoMere: true })).status, 400, 'pas dans le futur');
  assert.equal((await enregistrerEnfant('infirmiere', { enfant: { ...enfant, dateNaissance: '2010-01-01' }, nouvelleMere: mere, compte }, { photoMere: true })).status, 400, 'âge préscolaire');
  assert.equal((await enregistrerEnfant('infirmiere', {
    enfant, nouvelleMere: mere, compte, vaccinationsAnterieures: [{ code: 'bcg' }],
  }, { photoMere: true })).status, 400, 'date de la dose reportée obligatoire');

  // Infirmière (vaccination) : mère et enfant créés ensemble.
  const r = await enregistrerEnfant('infirmiere', { enfant, nouvelleMere: mere, compte, vaccinationsAnterieures: anterieures }, { photoMere: true });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  assert.equal(r.corps.origine, 'Né hors plateforme');
  assert.equal(r.corps.lieuNaissance, 'CS Fictif de Lemba');
  assert.equal(r.corps.accouchementId, null);
  assert.equal(r.corps.dateNaissance, neLe);
  assert.equal(r.corps.nom, 'TSHALA', 'nom de la mère par défaut');
  assert.ok(r.corps.photoUrl);
  assert.equal(r.corps.naissance.poidsG, 3100);
  assert.deepEqual(r.corps.vaccinations.map((v) => [v.code, v.reportee]), [['bcg', true], ['vpo0', true]]);
  const statut = (code) => r.corps.carnet.doses.find((x) => x.code === code).statut;
  assert.equal(statut('bcg'), 'Faite');
  assert.equal(statut('penta1'), 'En retard', '6 semaines dépassées');
  assert.equal(r.corps.carnet.prochaineSeance.date, require('../config/vaccination').jourKinshasa(), 'rattrapage dès aujourd’hui');
  assert.equal(r.corps.rendezVous.length, 1, 'prochaine séance programmée');

  const Patiente = require('../models/Patiente');
  const m = await Patiente.findById(r.corps.mere.id);
  assert.equal(m.enregistreeVia, 'Enregistrement enfant');
  assert.equal(m.statut, 'Suivi postnatal');
  assert.ok(m.photoCle);

  // La mère suit son enfant dans l'application patiente.
  const c = await appel(null, 'POST', '/espace-patiente/connexion', { email: 'ruth.tshala@essai.test', motDePasse: 'Vaccin2026ok' });
  assert.equal(c.status, 200, JSON.stringify(c.corps));
  const accueil = await appel(c.corps.jeton, 'GET', '/espace-patiente/accueil');
  assert.equal(accueil.status, 200, JSON.stringify(accueil.corps));
  assert.ok(accueil.corps.enfants.some((x) => x.prenom === 'Divine'));

  // Même mère revenue : son dossier est proposé ; le même enfant n'est pas enregistré deux fois.
  const memeEmail = await enregistrerEnfant('infirmiere', { enfant, nouvelleMere: mere, compte }, { photoMere: true });
  assert.equal(memeEmail.status, 409);
  assert.equal(memeEmail.corps.doublons[0].numero, m.numero);
  const deuxFois = await enregistrerEnfant('infirmiere', { enfant, mereId: m.numero });
  assert.equal(deuxFois.status, 409);
  assert.equal(deuxFois.corps.enfantExistant.numero, r.corps.numero);

  // Second enfant de la même mère (dossier existant), sans photo de la mère.
  const frere = await enregistrerEnfant('infirmiere', { enfant: { prenom: 'Josué', sexe: 'Masculin', dateNaissance: ilYaJ(400) }, mereId: m.numero });
  assert.equal(frere.status, 201, JSON.stringify(frere.corps));
  assert.equal(frere.corps.mere.numero, m.numero);
  const liste = await appel('infirmiere', 'GET', `/enfants?mereId=${m.id}`);
  assert.equal(liste.corps.length, 2);
  assert.ok(liste.corps.every((x) => x.origine === 'Né hors plateforme'));
});
