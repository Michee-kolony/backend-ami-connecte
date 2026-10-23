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

  const latence = await saisir({ le: ilYaH(11), dilatationCm: 2, bcf: 140, contractions10min: 2, dureeContractionsSec: 30, saignement: '0' });
  assert.equal(latence.status, 201, JSON.stringify(latence.corps));
  assert.equal(latence.corps.surveillance.phase, 'Latence');
  assert.equal(latence.corps.alertes.length, 0);

  const debutActive = await saisir({ le: ilYaH(10), dilatationCm: 4, bcf: 170, membranes: 'Rompues', liquideAmniotique: 'Clair', engagement: 'F' });
  assert.equal(debutActive.corps.surveillance.phase, 'Active');
  assert.deepEqual(debutActive.corps.alertes.map((x) => x.code), ['BCF'], 'BCF > 160');
  assert.equal(debutActive.corps.alertes[0].sonore, true);

  const jaune = await saisir({ le: ilYaH(8), dilatationCm: 5, bcf: 138 });
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
  assert.equal(dossier.corps.partogramme.bcf.points.length, 5);

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
    nouveauNes: [{
      prenom: 'Joie', sexe: 'Féminin',
      naissance: {
        senn: { maintienTemperature: true, temperatureAxillaire: 36.8, crede: true }, soinsCordon: { lameSterile: true, filSterile: true },
        miseAuSeinMoins1h: true, poidsG: 3200, tailleCm: 50, perimetreCranienCm: 34,
        apgar: { m1: { respiration: 2, fc: 2, coloration: 1, reflexes: 2, tonus: 1 }, m5: { respiration: 2, fc: 2, coloration: 2, reflexes: 2, tonus: 2 } },
        reanimation: { faite: false }, traitement: { vitamineK1: true },
      },
    }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.equal(r.corps.statut, 'Post-partum');
  assert.equal(r.corps.accouchement.delivrance.hemorragie, 'Pathologique', '650 ml > 500 ml');
  assert.equal(r.corps.accouchement.accoucheur, 'Marie MEDECIN');
  assert.equal(r.corps.nouveauNes.length, 1);
  assert.equal(r.corps.planningPostPartum.length, 16, '4 + 4 + 2 créneaux, 4e-6e heure, J1-J3');
  enfantId = r.corps.nouveauNes[0].id;

  assert.equal((await appel('sageFemme', 'POST', `/accouchements/${dossierId}/surveillances`, { bcf: 140 })).status, 409, 'plus de partogramme après l’accouchement');

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

  const accueil = await appel(jeton, 'GET', '/espace-patiente/accueil');
  assert.equal(accueil.status, 200);
  assert.equal(accueil.corps.enfants[0].prenom, 'Joie');
  assert.ok(accueil.corps.enfants[0].vaccination.prochaineSeance);
  const motifs = accueil.corps.prochainsRendezVous.map((r) => r.motif);
  assert.ok(motifs.includes('Consultation postnatale (CPoN)'), 'RDV de la mère');
  assert.ok(accueil.corps.prochainsRendezVous.some((r) => r.enfant?.prenom === 'Joie'), 'RDV du bébé');

  const enfants = await appel(jeton, 'GET', '/espace-patiente/enfants');
  const bebe = enfants.corps[0];
  assert.equal(bebe.naissance.poidsG, 3200);
  assert.equal(bebe.carnet.doses.find((d) => d.code === 'bcg').statut, 'Faite');
  assert.equal(bebe.croissance.length, 1);
  assert.ok(!('administreePar' in bebe.carnet.doses[0]), 'pas d’identifiant de soignant');

  const accouchements = await appel(jeton, 'GET', '/espace-patiente/accouchements');
  assert.equal(accouchements.corps[0].mode, 'Normal');
  assert.ok(accouchements.corps[0].mesuresPreventives.nouveauNe.includes('BCG / VPO'));
  assert.ok(!('surveillances' in accouchements.corps[0]), 'pas de partogramme');

  // Autre patiente : l'enfant d'Esther lui est invisible.
  const autre = await creerPatiente({ patiente: { nom: 'Autre', prenom: 'Mère', ageDeclare: 30, email: 'autre@essai.test', adresse: { province: 'Kinshasa' } }, compte: { motDePasse: 'Autre2026ok' } });
  assert.equal(autre.status, 201);
  const jetonAutre = (await appel(null, 'POST', '/espace-patiente/connexion', { email: 'autre@essai.test', motDePasse: 'Autre2026ok' })).corps.jeton;
  assert.equal((await appel(jetonAutre, 'GET', `/espace-patiente/enfants/${enfantId}`)).status, 404);
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
  const acc = await appel('medecin', 'PUT', `/accouchements/${a.corps.id}/accouchement`, { mode: 'Normal', heure: ilYaH(1), nouveauNes: [{ prenom: 'Temp', sexe: 'Masculin' }] });
  assert.equal(acc.status, 200, JSON.stringify(acc.corps));
  const bebe = acc.corps.nouveauNes[0];
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
