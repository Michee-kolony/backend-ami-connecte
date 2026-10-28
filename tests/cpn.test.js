// Tests d'API du suivi prénatal (critères d'acceptation AC-xx du cahier des charges).
// Base MongoDB en mémoire, données fictives : aucune donnée réelle n'est lue ni écrite.
// Lancer : npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');

let serveurMongo;
let api;
let http;
let mongoose;
let Soignant;
let JournalAudit;
const etablissements = {};
const jetons = {};
const comptes = {};

async function appel(qui, methode, chemin, corps) {
  const r = await fetch(`${api}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', ...(jetons[qui] ? { Authorization: `Bearer ${jetons[qui]}` } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  return { status: r.status, corps: texte ? JSON.parse(texte) : null };
}

// Photo fictive (PNG 1×1) et compte patiente par défaut pour chaque création.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let compteur = 0;
const r2Appels = { envoyes: [], supprimes: [] };

/** Enregistrement multipart, comme le formulaire du tableau de bord (données JSON + photo). */
async function creer(qui, corps, { photo = true } = {}) {
  const donnees = structuredClone(corps);
  if (donnees.patiente && !('email' in donnees.patiente)) donnees.patiente.email = `patiente${++compteur}@essai.test`;
  if (!('compte' in donnees)) donnees.compte = { motDePasse: 'Grossesse2026' };
  const f = new FormData();
  f.append('donnees', JSON.stringify(donnees));
  if (photo) f.append('photo', new Blob([PNG], { type: 'image/png' }), 'photo.png');
  const r = await fetch(`${api}/patientes`, { method: 'POST', headers: { Authorization: `Bearer ${jetons[qui]}` }, body: f });
  const texte = await r.text();
  return { status: r.status, corps: texte ? JSON.parse(texte) : null };
}

const ilYa = (jours) => new Date(Date.now() - jours * 86400000).toISOString().slice(0, 10);
const dansJours = (jours, heure = 9) => {
  const d = new Date(Date.now() + jours * 86400000);
  d.setUTCHours(heure, 0, 0, 0);
  return d.toISOString();
};

before(async () => {
  serveurMongo = await MongoMemoryServer.create();
  // Prioritaires sur .env (process.loadEnvFile n'écrase pas les variables existantes).
  process.env.MONGODB_URI = serveurMongo.getUri('ami_connecte_essai');
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  // Stockage R2 simulé : aucun fichier n'est envoyé (à remplacer avant le chargement des contrôleurs).
  const r2 = require('../config/r2');
  r2.envoyerFichier = async (fichier, dossier) => {
    const cle = `${dossier}/essai-${r2Appels.envoyes.length}.png`;
    r2Appels.envoyes.push({ cle, type: fichier.mimetype, taille: fichier.size });
    return { cle, url: `https://public.invalid/${cle}` };
  };
  r2.supprimerFichier = async (cle) => { r2Appels.supprimes.push(cle); };
  r2.urlSignee = async (cle) => (cle ? `https://signe.invalid/${cle}?X-Amz-Expires=900` : null);
  // Photo lue dans R2 pour la carte : le logo sert d'image fictive.
  r2.lireFichier = async (cle) => (cle ? require('fs').readFileSync(require('path').join(__dirname, '..', 'assets', 'logo-icon.png')) : null);
  const app = require('../app');
  mongoose = require('mongoose');
  await mongoose.connection.asPromise();
  // Garde-fou : on ne travaille que sur la base en mémoire.
  assert.equal(mongoose.connection.name, 'ami_connecte_essai');
  assert.ok(serveurMongo.getUri().includes(mongoose.connection.host));

  Soignant = require('../models/Soignant');
  JournalAudit = require('../models/JournalAudit');
  const jwt = require('jsonwebtoken');
  const Etablissement = require('../models/Etablissement');
  const baseEt = { type: 'Centre de santé', secteur: 'Public', province: 'Kinshasa', zoneSante: 'ZS Fictive', adresse: 'Fictive', telephone: '000', responsable: 'Fictif', services: ['CPN'] };
  etablissements.connexion = await Etablissement.create({ ...baseEt, code: 'ETS-T-10', nom: 'Centre de connexion' });
  etablissements.autre = await Etablissement.create({ ...baseEt, code: 'ETS-T-11', nom: 'Maternité choisie', province: 'Kwilu' });
  etablissements.suspendu = await Etablissement.create({ ...baseEt, code: 'ETS-T-12', nom: 'Centre suspendu', statut: 'Suspendu' });
  const base = {
    postnom: 'TEST', sexe: 'M', dateNaissance: '1985-01-01', lieuNaissance: 'Kinshasa', nationalite: 'Congolaise',
    pieceType: 'Passeport', adresse: 'Fictive', telephone: '000', grade: 'Médecin généraliste',
    specialite: 'Médecine générale', affectations: [{ etablissementId: 'ET-TEST' }], motDePasse: 'x',
  };
  const definitions = {
    chef: { prenom: 'Alain', nom: 'CHEF', role: 'Médecin chef de service', matricule: 'MED-9001' },
    medecinA: { prenom: 'Aimée', nom: 'AMANI', role: 'Médecin', matricule: 'MED-9002' },
    medecinB: { prenom: 'Bruno', nom: 'BOKANGA', role: 'Médecin', matricule: 'MED-9003' },
    infirmiere: { prenom: 'Inès', nom: 'ILUNGA', role: 'Infirmier(ère)', matricule: 'INF-9001' },
    sageFemme: { prenom: 'Sarah', nom: 'SAFI', role: 'Sage-femme', matricule: 'SFM-9001' },
    suspendu: { prenom: 'Serge', nom: 'SUSPENDU', role: 'Médecin', matricule: 'MED-9004', statut: 'Suspendu' },
  };
  for (const [cle, d] of Object.entries(definitions)) {
    comptes[cle] = await Soignant.create({ ...base, ...d, email: `${cle}@essai.test` });
    // Établissement choisi à la connexion : utilisé par défaut à l'enregistrement.
    jetons[cle] = jwt.sign({ sub: comptes[cle].id, role: d.role, etablissement: etablissements.connexion.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
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

// Patiente fictive partagée par les scénarios.
const patiente = {
  nom: 'Mukeba', prenom: 'Grâce', postnom: 'Lusamba', dateNaissance: '1998-03-14', telephone: '+243 81 000 1122',
  adresse: { province: 'Kinshasa', commune: 'Ngaliema', quartier: 'Fictif' },
  consentements: { sms: true, appel: true, whatsapp: false },
};
let dossier; // { id, numero }
let grossesseId;
let consultationA;

test('enregistrement : identifiant AC-PAT, datation par DDR et premier rendez-vous', async () => {
  const ddr = ilYa(70);
  const r = await creer('medecinA', {
    patiente,
    grossesse: { datation: { methode: 'DDR', ddr, ddrFiabilite: 'Fiable' }, facteursRisque: [] },
    rendezVous: { date: dansJours(0, 23), motif: 'Première CPN' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  assert.match(r.corps.numero, /^AC-PAT-\d{6}$/);
  dossier = r.corps;

  const d = await appel('medecinA', 'GET', `/patientes/${dossier.numero}`);
  assert.equal(d.status, 200);
  const g = d.corps.grossesses[0];
  grossesseId = g.id;
  const { dpaNaegele } = require('../models/Grossesse');
  assert.equal(g.datation.dpa, dpaNaegele(ddr), 'DPA = DDR + 7 jours + 9 mois (Naegele)');
  assert.equal(g.agJours, 70);
  assert.equal(g.datation.valideePar.id, comptes.medecinA.id);
  assert.equal(d.corps.patiente.creePar.id, comptes.medecinA.id);
  assert.equal(d.corps.rendezVous.length, 1);
});

test('doublons : signalés avant création, création possible après confirmation explicite', async () => {
  const r = await creer('medecinB', { patiente: { ...patiente, telephone: '' } });
  assert.equal(r.status, 409);
  assert.equal(r.corps.doublons[0].numero, dossier.numero);
  assert.ok(!('telephone' in r.corps.doublons[0]), 'téléphone non exposé');
  const parTel = await appel('medecinB', 'GET', `/patientes/doublons?telephone=${encodeURIComponent('0810001122')}`);
  assert.equal(parTel.corps.length, 1, 'doublon trouvé par téléphone quel que soit le format');
  const confirme = await creer('medecinB', { patiente: { ...patiente, telephone: '' }, confirmerMalgreDoublons: true });
  assert.equal(confirme.status, 201);
  assert.notEqual(confirme.corps.numero, dossier.numero);
});

test('formulaire du tableau de bord : grossesse non datée, valeurs nulles, sans rendez-vous', async () => {
  // Corps tel qu'envoyé par patient-new.component.ts quand la DDR est inconnue et l'AG non saisi.
  const r = await creer('medecinA', {
    patiente: {
      nom: 'Formulaire', postnom: '', prenom: 'Essai', dateNaissance: null, ageDeclare: 31, pieceIdentite: '',
      telephone: '', telephonePartage: false, telephone2: '', email: 'formulaire@essai.test',
      contactUrgence: { nom: '', lien: '', telephone: '' }, consentements: { sms: null, appel: null, whatsapp: null, version: 'v1.2' },
      adresse: { province: 'Kinshasa', commune: '', quartier: '', avenue: '', repere: '', aireSante: '' },
      antecedents: { gestite: null, parite: null, enfantsVivants: null, avortements: null, cesariennes: null, complicationsObstetricales: '', medicaux: '', chirurgicaux: '', allergies: '', medicaments: '' },
    },
    grossesse: { datation: null, facteursRisque: [], grossesseMultiple: null },
    rendezVous: null,
    confirmerMalgreDoublons: false,
  });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  const d = await appel('medecinA', 'GET', `/patientes/${r.corps.numero}`);
  assert.equal(d.corps.grossesses[0].datation, undefined, 'aucune datation inventée');
  assert.equal(d.corps.grossesses[0].agJours, null);
  assert.equal(d.corps.patiente.age, 31);
  // Datation ensuite par échographie, avec motif archivé à la correction.
  const g = d.corps.grossesses[0].id;
  const echo = await appel('medecinA', 'PUT', `/grossesses/${g}/datation`, { methode: 'Échographie', dateReference: ilYa(7), agSemaines: 12, agJours: 0 });
  assert.equal(echo.status, 200, JSON.stringify(echo.corps));
  assert.equal(echo.corps.agJours, 12 * 7 + 7);
  assert.equal((await appel('medecinA', 'PUT', `/grossesses/${g}/datation`, { methode: 'DDR', ddr: ilYa(90) })).status, 400, 'motif exigé pour remplacer une datation');
  const corrigee = await appel('medecinB', 'PUT', `/grossesses/${g}/datation`, { methode: 'DDR', ddr: ilYa(90), justification: 'DDR retrouvée sur le carnet' });
  assert.equal(corrigee.status, 200);
  assert.equal(corrigee.corps.historiqueDatation.length, 1);
  assert.equal(corrigee.corps.historiqueDatation[0].valideePar.id, comptes.medecinA.id, 'ancienne valeur et son auteur conservés');
});

test('établissement sanitaire : choisi dans le formulaire parmi les actifs, sinon celui de la connexion', async () => {
  const choisi = await creer('medecinA', {
    patiente: { nom: 'Etab', prenom: 'Choisi', ageDeclare: 24, adresse: { province: 'Kwilu' } },
    etablissementId: etablissements.autre.id,
  });
  assert.equal(choisi.status, 201, JSON.stringify(choisi.corps));
  const d = await appel('medecinA', 'GET', `/patientes/${choisi.corps.numero}`);
  assert.equal(d.corps.patiente.etablissementId, etablissements.autre.id);
  assert.equal(d.corps.etablissement.nom, 'Maternité choisie');
  const parDefaut = await appel('medecinA', 'GET', `/patientes/${dossier.numero}`);
  assert.equal(parDefaut.corps.patiente.etablissementId, etablissements.connexion.id);
  for (const etablissementId of [etablissements.suspendu.id, '64b000000000000000000000', 'ET-001']) {
    const r = await creer('medecinA', { patiente: { nom: 'Etab', prenom: 'Refus', ageDeclare: 24, adresse: { province: 'Kinshasa' } }, etablissementId });
    assert.equal(r.status, 400, etablissementId);
  }
});

test('datation : règle de Naegele (mois 1 à 3 : + 9 ; mois 4 à 12 : − 3 et année + 1 ; jour + 7)', () => {
  const { dpaNaegele } = require('../models/Grossesse');
  assert.equal(dpaNaegele('2026-01-10'), '2026-10-17'); // janvier à mars : mois + 9, même année
  assert.equal(dpaNaegele('2026-05-04'), '2027-02-11'); // avril à décembre : mois − 3, année + 1
  assert.equal(dpaNaegele('2026-01-28'), '2026-11-04'); // jour + 7 qui déborde sur le mois suivant
  assert.equal(dpaNaegele('2026-12-25'), '2027-10-02'); // décembre : septembre de l'année suivante, puis + 7 j
  assert.equal(dpaNaegele('2026-03-28'), '2027-01-04'); // mars (+ 9) : 35 décembre → 4 janvier
  assert.equal(dpaNaegele('2026-05-24'), '2027-03-03'); // 31 février 2027 → 3 mars
});

test('datation : une DPA enregistrée avec l’ancien calcul (DDR + 280 j) est affichée selon Naegele', async () => {
  const { dpaNaegele } = require('../models/Grossesse');
  const collection = mongoose.connection.collection('grossesses');
  const _id = new mongoose.Types.ObjectId(grossesseId);
  const { datation } = await collection.findOne({ _id });
  const ancienne = new Date(Date.parse(`${datation.ddr}T00:00:00Z`) + 280 * 86400000).toISOString().slice(0, 10);
  await collection.updateOne({ _id }, { $set: { 'datation.dpaCalculee': ancienne, 'datation.dpa': ancienne } });

  const d = await appel('medecinA', 'GET', `/patientes/${dossier.numero}`);
  const g = d.corps.grossesses.find((x) => x.id === grossesseId);
  assert.equal(g.datation.dpaCalculee, dpaNaegele(datation.ddr));
  assert.equal(g.datation.dpa, dpaNaegele(datation.ddr), 'DPA estimée = date calculée');
});

test('datation : DPA corrigée de plus de 7 jours refusée sans justification', async () => {
  const r = await creer('medecinA', {
    patiente: { nom: 'Datation', prenom: 'Essai', ageDeclare: 25, adresse: { province: 'Kinshasa' } },
    grossesse: { datation: { methode: 'DDR', ddr: ilYa(30), dpa: '2099-01-01' } },
  });
  assert.equal(r.status, 400);
  assert.match(r.corps.message, /Justifiez/);
});

test('AC-04 / AC-05 : une infirmière est refusée côté serveur sur le dossier médical, et le refus est journalisé', async () => {
  for (const [methode, chemin] of [
    ['GET', `/patientes/${dossier.numero}`], ['POST', '/patientes'], ['GET', '/patientes/doublons?nom=X'],
    ['GET', `/grossesses/${grossesseId}/consultations`], ['GET', `/patientes/${dossier.numero}/journal`],
    ['GET', `/patientes/${dossier.numero}/carte`], ['PATCH', `/grossesses/${grossesseId}`],
  ]) {
    const r = await appel('infirmiere', methode, chemin, methode === 'POST' ? { patiente } : undefined);
    assert.equal(r.status, 403, `${methode} ${chemin}`);
  }
  const refus = await JournalAudit.find({ action: 'acces.refuse', 'acteur.id': comptes.infirmiere.id });
  assert.ok(refus.length >= 6);
  assert.equal(refus[0].resultat, 'refusé');
});

test('AC-13 : un médecin suspendu ne peut plus accéder aux dossiers, même avec son ancien jeton', async () => {
  const r = await appel('suspendu', 'GET', `/patientes/${dossier.numero}`);
  assert.equal(r.status, 401);
});

test('AC-06 : le médecin A fait la première consultation, le médecin B la suivante — chacun reste auteur', async () => {
  const a = await appel('medecinA', 'POST', `/grossesses/${grossesseId}/consultations`, {
    type: 'Première consultation prénatale', date: new Date().toISOString(), motif: 'Première CPN',
    constantes: { poidsKg: 62, taSystolique: 110, taDiastolique: 70 },
    // Tentative d'usurpation : l'auteur vient toujours de la session.
    auteur: { id: comptes.medecinB.id, nom: 'Faux', role: 'Médecin' },
    prochainRdv: { date: dansJours(28), motif: 'CPN 2' },
    finaliser: true,
  });
  assert.equal(a.status, 200, JSON.stringify(a.corps));
  assert.equal(a.corps.statut, 'Finalisée');
  assert.equal(a.corps.auteur.id, comptes.medecinA.id);
  assert.ok(a.corps.prochainRdvId, 'prochain rendez-vous ajouté à l’agenda');
  consultationA = a.corps;

  const b = await appel('medecinB', 'POST', `/grossesses/${grossesseId}/consultations`, { type: 'Suivi prénatal', motif: 'Suivi', finaliser: true });
  assert.equal(b.status, 200);
  assert.equal(b.corps.auteur.id, comptes.medecinB.id);

  const d = await appel('medecinB', 'GET', `/patientes/${dossier.numero}`);
  assert.equal(d.corps.premiereConsultation.medecin.id, comptes.medecinA.id);
  assert.deepEqual(d.corps.consultations.map((c) => c.auteur.id).sort(), [comptes.medecinA.id, comptes.medecinB.id].sort());
  const premierRdv = d.corps.rendezVous.find((r) => r.motif === 'Première CPN');
  assert.equal(premierRdv.statut, 'Effectué', 'le rendez-vous du jour est marqué honoré');
});

test('une seconde « première consultation » finalisée est refusée', async () => {
  const r = await appel('medecinB', 'POST', `/grossesses/${grossesseId}/consultations`, { type: 'Première consultation prénatale' });
  assert.equal(r.status, 409);
});

test('AC-01 / AC-07 : un autre médecin ouvre le dossier — accès journalisé, aucune consultation fictive', async () => {
  const avant = await appel('chef', 'GET', `/patientes/${dossier.numero}`);
  assert.equal(avant.status, 200);
  const lectures = await JournalAudit.find({ action: 'dossier.lecture', 'acteur.id': comptes.chef.id });
  assert.equal(lectures.length, 1);
  assert.equal(avant.corps.consultations.filter((c) => c.auteur.id === comptes.chef.id).length, 0);
});

test('AC-08 : consultation finalisée non modifiable ; addendum ajouté sans écraser la note initiale', async () => {
  const modif = await appel('medecinA', 'PATCH', `/consultations/${consultationA.id}`, { motif: 'Réécriture' });
  assert.equal(modif.status, 409);
  const sansMotif = await appel('medecinB', 'POST', `/consultations/${consultationA.id}/addenda`, { texte: 'Précision' });
  assert.equal(sansMotif.status, 400);
  const add = await appel('medecinB', 'POST', `/consultations/${consultationA.id}/addenda`, { texte: 'TA recontrôlée à 112/72.', motif: 'Mesure complémentaire' });
  assert.equal(add.status, 201);
  assert.equal(add.corps.motif, 'Première CPN', 'note initiale intacte');
  assert.equal(add.corps.addenda[0].auteur.id, comptes.medecinB.id);
});

test('brouillon : seul son auteur peut le compléter ; annulation avec motif, jamais supprimé', async () => {
  const brouillon = await appel('medecinA', 'POST', `/grossesses/${grossesseId}/consultations`, { type: 'Consultation non programmée', motif: 'Céphalées' });
  assert.equal(brouillon.status, 201);
  assert.equal(brouillon.corps.statut, 'Brouillon');
  assert.equal((await appel('medecinB', 'PATCH', `/consultations/${brouillon.corps.id}`, { motif: 'x' })).status, 403);
  assert.equal((await appel('medecinA', 'PATCH', `/consultations/${brouillon.corps.id}`, { symptomes: 'Depuis 2 jours' })).status, 200);
  assert.equal((await appel('medecinA', 'POST', `/consultations/${brouillon.corps.id}/annuler`, {})).status, 400);
  const annulee = await appel('medecinA', 'POST', `/consultations/${brouillon.corps.id}/annuler`, { motif: 'Saisie en double' });
  assert.equal(annulee.corps.statut, 'Annulée');
  assert.equal((await appel('medecinA', 'DELETE', `/consultations/${brouillon.corps.id}`)).status, 404, 'aucune route de suppression');
  const d = await appel('medecinA', 'GET', `/patientes/${dossier.numero}`);
  assert.ok(d.corps.consultations.some((c) => c.id === brouillon.corps.id && c.statut === 'Annulée'));
});

test('AC-09 : report d’un rendez-vous — état mis à jour, ancien créneau, auteur et motif conservés', async () => {
  const d = await appel('medecinA', 'GET', `/patientes/${dossier.numero}`);
  const rdv = d.corps.rendezVous.find((r) => r.motif === 'CPN 2');
  const sansMotif = await appel('medecinB', 'PATCH', `/rendez-vous/${rdv.id}`, { action: 'reporter', date: dansJours(30) });
  assert.equal(sansMotif.status, 400);
  const r = await appel('medecinB', 'PATCH', `/rendez-vous/${rdv.id}`, { action: 'reporter', date: dansJours(30), motif: 'Indisponibilité de la patiente' });
  assert.equal(r.status, 200);
  assert.equal(r.corps.statut, 'Reporté');
  const evt = r.corps.historique.at(-1);
  assert.equal(new Date(evt.ancienneDate).toISOString(), new Date(rdv.date).toISOString());
  assert.equal(evt.par.id, comptes.medecinB.id);
  assert.equal(evt.motif, 'Indisponibilité de la patiente');
  const doublon = await appel('medecinA', 'POST', `/patientes/${dossier.numero}/rendez-vous`, { date: dansJours(30, 14), motif: 'Échographie' });
  assert.equal(doublon.status, 409, 'deux rendez-vous attendus le même jour refusés');
});

test('AC-14 : recherche paginée et minimisée', async () => {
  for (let i = 0; i < 25; i++) {
    await creer('medecinA', { patiente: { nom: `Lot${i}`, prenom: 'Essai', ageDeclare: 20 + (i % 10), telephone: `+243 99 000 ${String(1000 + i)}`, adresse: { province: i < 5 ? 'Nord-Kivu' : 'Kinshasa' } } });
  }
  const r = await appel('medecinB', 'GET', '/patientes?q=Lot&parPage=10&page=2');
  assert.equal(r.status, 200);
  assert.equal(r.corps.total, 25);
  assert.equal(r.corps.resultats.length, 10);
  const p = r.corps.resultats[0];
  assert.ok(!('telephone' in p) && p.telephoneMasque.startsWith('••••'), 'téléphone masqué');
  assert.ok(!('antecedents' in p) && !('consentements' in p), 'pas de données cliniques dans la liste');
  const max = await appel('medecinB', 'GET', '/patientes?q=Lot&parPage=1000');
  assert.equal(max.corps.resultats.length, 25);
  assert.equal(max.corps.parPage, 50, 'taille de page plafonnée');
  const parTel = await appel('medecinB', 'GET', `/patientes?q=${encodeURIComponent('99 000 1003')}`);
  assert.equal(parTel.corps.total, 1);
  const parProvince = await appel('medecinB', 'GET', `/patientes?q=Lot&province=${encodeURIComponent('Nord-Kivu')}`);
  assert.equal(parProvince.corps.total, 5, 'filtre par province');
  assert.equal(parProvince.corps.resultats[0].province, 'Nord-Kivu');
});

test('province de résidence : une des 26 provinces, exigée à l’enregistrement', async () => {
  const ref = await appel('medecinA', 'GET', '/referentiels/provinces');
  assert.equal(ref.status, 200);
  assert.equal(ref.corps.length, 26);
  assert.ok(ref.corps.includes('Kasaï-Oriental') && ref.corps.includes('Équateur'));
  assert.equal((await appel('infirmiere', 'GET', '/referentiels/provinces')).status, 200, 'référentiel non clinique');
  const sans = await creer('medecinA', { patiente: { nom: 'Province', prenom: 'Absente', ageDeclare: 22 } });
  assert.equal(sans.status, 400);
  assert.match(sans.corps.message, /province/i);
  const inconnue = await creer('medecinA', { patiente: { nom: 'Province', prenom: 'Inconnue', ageDeclare: 22, adresse: { province: 'Autre' } } });
  assert.equal(inconnue.status, 400);
  const modif = await appel('medecinA', 'PATCH', `/patientes/${dossier.numero}`, { adresse: { province: 'Katanga' } });
  assert.equal(modif.status, 400, 'ancienne province (avant 2015) refusée');
});

test('issue de grossesse : grossesse close et dossier en suivi postnatal, historique conservé', async () => {
  const r = await appel('medecinB', 'POST', `/grossesses/${grossesseId}/issue`, { date: ilYa(0), issue: 'Naissance vivante', mode: 'Voie basse', lieu: 'Maternité fictive' });
  assert.equal(r.status, 200);
  assert.equal(r.corps.statut, 'Terminée');
  const d = await appel('medecinA', 'GET', `/patientes/${dossier.numero}`);
  assert.equal(d.corps.patiente.statut, 'Suivi postnatal');
  assert.ok(d.corps.consultations.length >= 3, 'consultations toujours accessibles');
});

test('AC-15 : journal d’audit en ajout seul, sans contenu clinique ni secret', async () => {
  await assert.rejects(() => JournalAudit.updateOne({}, { action: 'falsifié' }), /ni modifié ni supprimé/);
  await assert.rejects(() => JournalAudit.deleteMany({}), /ni modifié ni supprimé/);
  const tout = JSON.stringify(await JournalAudit.find().lean());
  for (const sensible of ['Céphalées', 'TA recontrôlée', 'Indisponibilité de la patiente', 'Mukeba', 'secret-de-test', 'Bearer']) {
    assert.ok(!tout.includes(sensible), `« ${sensible} » ne doit pas figurer dans le journal`);
  }
  const j = await appel('medecinA', 'GET', `/patientes/${dossier.numero}/journal`);
  assert.equal(j.status, 200);
  assert.ok(j.corps.some((e) => e.action === 'dossier.lecture' && e.acteur.id === comptes.chef.id));
  assert.equal((await appel('medecinA', 'GET', '/journal')).status, 403, 'journal global réservé au médecin chef');
  assert.equal((await appel('chef', 'GET', '/journal')).status, 200);
});

test('photo et compte patiente obligatoires ; mot de passe haché, jamais renvoyé ; photo par lien signé', async () => {
  const base = { patiente: { nom: 'Compte', prenom: 'Essai', ageDeclare: 26, adresse: { province: 'Kinshasa' } } };
  const sansPhoto = await creer('medecinA', base, { photo: false });
  assert.equal(sansPhoto.status, 400);
  assert.match(sansPhoto.corps.message, /photo/i);
  const sansEmail = await creer('medecinA', { ...base, patiente: { ...base.patiente, email: '' } });
  assert.equal(sansEmail.status, 400);
  assert.match(sansEmail.corps.message, /e-mail/i);
  for (const motDePasse of ['court1', 'sanschiffre', '12345678', undefined]) {
    const r = await creer('medecinA', { ...base, compte: { motDePasse } });
    assert.equal(r.status, 400, String(motDePasse));
  }
  const envoisAvant = r2Appels.envoyes.length;
  const ok = await creer('medecinA', { ...base, patiente: { ...base.patiente, email: 'Grace.Compte@Essai.test' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.corps));
  assert.equal(r2Appels.envoyes.length, envoisAvant + 1, 'photo envoyée seulement quand tout est valide');
  assert.equal(r2Appels.envoyes.at(-1).type, 'image/png');
  const doublonEmail = await creer('medecinA', { ...base, patiente: { ...base.patiente, prenom: 'Autre', email: 'grace.compte@essai.test' } });
  assert.equal(doublonEmail.status, 409);

  const d = await appel('medecinA', 'GET', `/patientes/${ok.corps.numero}`);
  assert.equal(d.corps.patiente.email, 'grace.compte@essai.test');
  assert.equal(d.corps.patiente.espaceEnLigne, 'Activé');
  assert.ok(!('motDePasse' in d.corps.patiente) && !('photoCle' in d.corps.patiente), 'ni mot de passe ni clé R2 exposés');
  assert.match(d.corps.patiente.photoUrl, /^https:\/\/signe\.invalid\/patiente\/.*X-Amz-Expires=900/);
  const Patiente = require('../models/Patiente');
  const enBase = await Patiente.findOne({ numero: ok.corps.numero }).select('+motDePasse');
  assert.ok(enBase.motDePasse.startsWith('$2') && enBase.motDePasse !== 'Grossesse2026', 'mot de passe haché (bcrypt)');
  const effacer = await appel('medecinA', 'PATCH', `/patientes/${ok.corps.numero}`, { email: '' });
  assert.equal(effacer.status, 400, 'l’e-mail de connexion ne peut pas être effacé');
  const liste = await appel('medecinA', 'GET', `/patientes?q=${ok.corps.numero}`);
  assert.ok(liste.corps.resultats[0].photoUrl.startsWith('https://signe.invalid/'));
});

test('suppression d’un dossier : médecin chef seulement, numéro à retaper, journal conservé', async () => {
  const r = await creer('medecinA', { patiente: { nom: 'Suppression', prenom: 'Essai', ageDeclare: 30, adresse: { province: 'Kinshasa' } }, rendezVous: { date: dansJours(3), motif: 'CPN' } });
  assert.equal(r.status, 201);
  const numero = r.corps.numero;
  const d = await appel('medecinA', 'GET', `/patientes/${numero}`);
  await appel('medecinA', 'POST', `/grossesses/${d.corps.grossesses[0].id}/consultations`, { type: 'Première consultation prénatale', finaliser: true });

  assert.equal((await appel('medecinA', 'DELETE', `/patientes/${numero}`, { confirmation: numero })).status, 403, 'un médecin ordinaire ne supprime pas');
  assert.equal((await appel('infirmiere', 'DELETE', `/patientes/${numero}`, { confirmation: numero })).status, 403);
  const mauvaise = await appel('chef', 'DELETE', `/patientes/${numero}`, { confirmation: 'AC-PAT-999999' });
  assert.equal(mauvaise.status, 400);
  assert.match(mauvaise.corps.message, new RegExp(numero));

  const supprimesAvant = r2Appels.supprimes.length;
  const res = await fetch(`${api}/patientes/${numero}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jetons.chef}` }, body: JSON.stringify({ confirmation: numero }),
  });
  assert.equal(res.status, 204);
  assert.equal(r2Appels.supprimes.length, supprimesAvant + 1, 'photo retirée de R2');
  assert.equal((await appel('chef', 'GET', `/patientes/${numero}`)).status, 404);
  const Consultation = require('../models/Consultation');
  const RendezVous = require('../models/RendezVous');
  const pid = d.corps.patiente.id;
  assert.equal(await Consultation.countDocuments({ patienteId: pid }), 0);
  assert.equal(await RendezVous.countDocuments({ patienteId: pid }), 0);
  const trace = await JournalAudit.findOne({ action: 'patiente.suppression', 'ressource.id': numero });
  assert.equal(trace.acteur.id, comptes.chef.id);
  assert.equal(trace.details.consultations, 1);
  assert.ok((await JournalAudit.countDocuments({ patienteId: pid })) > 1, 'les entrées antérieures du journal restent');
});

test('carte patiente : PDF recto-verso au format carte, QR vers le dossier, génération journalisée', async () => {
  const r = await fetch(`${api}/patientes/${dossier.numero}/carte`, { headers: { Authorization: `Bearer ${jetons.medecinB}` } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.ok(r.headers.get('content-disposition').includes(`carte-${dossier.numero}.pdf`));
  const pdf = Buffer.from(await r.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const brut = pdf.toString('latin1');
  assert.equal((brut.match(/\/Type \/Page[^s]/g) || []).length, 2, 'recto et verso');
  assert.match(brut, /MediaBox \[0 0 242\.6\d* 153\.0\d*\]/, 'format carte bancaire 85,6 × 54 mm');
  if (process.env.CARTE_ESSAI) require('fs').writeFileSync(process.env.CARTE_ESSAI, pdf);
  assert.equal((await fetch(`${api}/patientes/${dossier.numero}/carte`, { headers: { Authorization: `Bearer ${jetons.infirmiere}` } })).status, 403);
  assert.ok(await JournalAudit.exists({ action: 'patiente.carte', 'acteur.id': comptes.medecinB.id }));
  const { lienDossier, origineSite } = require('../controllers/carte');
  assert.equal(lienDossier('AC-PAT-000001'), 'http://localhost:4200/admin/patientes/AC-PAT-000001', 'le QR ne contient que le lien du dossier');
  // Le QR suit le domaine du site qui demande la carte (?site=, sinon Origin / Referer).
  const req = (query, entetes = {}) => ({ query, get: (n) => entetes[n] });
  assert.equal(origineSite(req({ site: 'https://ami-sante.vercel.app/admin/x' })), 'https://ami-sante.vercel.app');
  assert.equal(origineSite(req({}, { origin: 'https://ami.cd' })), 'https://ami.cd');
  assert.equal(origineSite(req({}, { referer: 'https://ami.cd/admin/patientes/AC-PAT-000001' })), 'https://ami.cd');
  assert.equal(origineSite(req({ site: 'javascript:alert(1)' })), null, 'adresse non http(s) ignorée');
  assert.equal(lienDossier('AC-PAT-000001', 'https://ami-sante.vercel.app'), 'https://ami-sante.vercel.app/admin/patientes/AC-PAT-000001');
});

test('infirmière et sage-femme : fiche de la patiente en lecture seule, sans données médicales sensibles', async () => {
  // Patiente avec facteur de risque, antécédents et consultation : rien de cela ne doit apparaître.
  const r = await creer('medecinA', {
    patiente: { nom: 'Suivi', prenom: 'Infirmiere', ageDeclare: 28, telephone: '+243 81 777 0001', adresse: { province: 'Kinshasa', quartier: 'Matonge' },
      etatCivil: 'Mariée', groupeSanguin: 'O', contactUrgence: { nom: 'Paul Suivi', lien: 'Époux', telephone: '+243 81 777 0002' },
      antecedents: { gestite: 3, allergies: 'Pénicilline', medicaux: 'Drépanocytose' } },
    grossesse: { datation: { methode: 'DDR', ddr: ilYa(84) }, facteursRisque: ['Hypertension artérielle'] },
    rendezVous: { date: dansJours(5), motif: 'CPN 2' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  const numero = r.corps.numero;
  const d = await appel('medecinA', 'GET', `/patientes/${numero}`);
  await appel('medecinA', 'POST', `/grossesses/${d.corps.grossesses[0].id}/consultations`, { type: 'Première consultation prénatale', motif: 'Céphalées sévères', finaliser: true });

  const s = await appel('infirmiere', 'GET', `/patientes/${numero}/suivi`);
  assert.equal(s.status, 200, JSON.stringify(s.corps));
  assert.equal(s.corps.grossesse.numero, 1);
  assert.equal(s.corps.grossesse.statut, 'En cours');
  assert.equal(s.corps.grossesse.agJours, 84);
  assert.ok(s.corps.grossesse.dpa);
  assert.equal(s.corps.rendezVous[0].motif, 'CPN 2');
  assert.ok(s.corps.patiente.photoUrl, 'photo pour identifier la patiente');
  assert.equal(s.corps.patiente.quartier, 'Matonge');
  assert.equal(s.corps.patiente.etatCivil, 'Mariée');
  assert.equal(s.corps.patiente.contactUrgence.telephone, '+243 81 777 0002');
  assert.equal(s.corps.visites.length, 1);
  assert.equal(s.corps.visites[0].type, 'Première consultation prénatale');
  assert.equal(s.corps.visites[0].soignant.nom, 'Aimée AMANI');
  const texte = JSON.stringify(s.corps);
  for (const sensible of ['Hypertension', 'Pénicilline', 'Drépanocytose', 'Céphalées', 'antecedents', 'facteursRisque', 'consultations',
    'constantes', 'groupeSanguin', 'echographies', 'email', 'datation']) {
    assert.ok(!texte.includes(sensible), `« ${sensible} » réservé aux médecins`);
  }

  // Sage-femme : même fiche, même restriction sur le dossier médical complet.
  const sf = await appel('sageFemme', 'GET', `/patientes/${numero}/suivi`);
  assert.equal(sf.status, 200, JSON.stringify(sf.corps));
  assert.equal(sf.corps.visites.length, 1);
  assert.equal((await appel('sageFemme', 'GET', `/patientes/${numero}`)).status, 403, 'dossier complet réservé aux médecins');

  const liste = await appel('infirmiere', 'GET', `/patientes?q=${numero}`);
  assert.equal(liste.status, 200);
  assert.equal(liste.corps.resultats[0].numero, numero);
  assert.ok(!('aRisque' in liste.corps.resultats[0].grossesse), 'pas d’indication de risque pour l’infirmière');
  assert.equal((await appel('medecinA', 'GET', `/patientes?q=${numero}`)).corps.resultats[0].grossesse.aRisque, true);

  const agenda = await appel('infirmiere', 'GET', '/rendez-vous');
  assert.equal(agenda.status, 200);
  assert.ok(agenda.corps.some((x) => x.patiente?.numero === numero));
  const rdvId = s.corps.rendezVous[0].id;
  assert.equal((await appel('infirmiere', 'PATCH', `/rendez-vous/${rdvId}`, { action: 'confirmer' })).status, 403, 'lecture seule');
  assert.equal((await appel('infirmiere', 'POST', `/patientes/${numero}/rendez-vous`, { date: dansJours(9), motif: 'x' })).status, 403);
  assert.ok(await JournalAudit.exists({ action: 'suivi.lecture', 'acteur.id': comptes.infirmiere.id }), 'accès journalisé');
});

test('tableau de bord : indicateurs calculés sur les données réelles, risque réservé aux médecins', async () => {
  const Patiente = require('../models/Patiente');
  const Grossesse = require('../models/Grossesse');
  const r = await appel('medecinA', 'GET', '/statistiques/patientes');
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  const s = r.corps;
  assert.equal(s.totaux.patientes, await Patiente.countDocuments());
  assert.equal(s.totaux.nouvellesCeMois, s.totaux.patientes, 'tous les dossiers d’essai datent de ce mois');
  const enCours = await Grossesse.countDocuments({ statut: 'En cours' });
  assert.equal(s.totaux.grossessesEnCours, enCours);
  assert.equal(s.trimestres.t1 + s.trimestres.t2 + s.trimestres.t3 + s.trimestres.nonDatees, enCours);
  assert.ok(s.totaux.grossessesARisque >= 1);
  assert.equal(s.semaines.length, 8);
  assert.equal(s.semaines.reduce((t, w) => t + w.inscriptions, 0), s.totaux.patientes, 'inscriptions de la semaine');
  assert.match(s.semaines[7].label, /^S\d{1,2}$/);
  assert.equal(s.provinces.length, 26);
  for (const nom of ['Nord-Kivu', 'Kinshasa', 'Kwilu']) {
    assert.equal(s.provinces.find((p) => p.province === nom).patientes, await Patiente.countDocuments({ 'adresse.province': nom }), nom);
  }
  assert.equal(s.provinces.reduce((t, p) => t + p.patientes, 0) + s.sansProvince, s.totaux.patientes);
  assert.equal(s.recentes.length, 5);
  assert.ok(s.recentes[0].photoUrl.startsWith('https://signe.invalid/'));
  assert.ok(s.prochainsRdv.every((x) => ['Planifié', 'Confirmé', 'Reporté'].includes(x.statut)));
  assert.ok(s.qualite.completude >= 0 && s.qualite.completude <= 100);

  const inf = await appel('infirmiere', 'GET', '/statistiques/patientes');
  assert.equal(inf.status, 200);
  assert.ok(!('grossessesARisque' in inf.corps.totaux), 'risque non communiqué aux infirmières');
  assert.ok(inf.corps.recentes.every((x) => !('aRisque' in x)));
  assert.ok(!JSON.stringify(inf.corps).includes('antecedents'));
});

test('fiche CPN : identité et antécédents cochés, examen, mesures préventives, laboratoire et référence horodatée', async () => {
  const ref = await appel('medecinA', 'GET', '/referentiels/cpn');
  assert.equal(ref.status, 200);
  assert.ok(ref.corps.MESURES_PREVENTIVES.some((m) => m.code === 'sp1' && m.semaine === 16));

  const r = await creer('medecinA', {
    patiente: {
      ...patiente, nom: 'Kabila', prenom: 'Esther', telephone: '+243 82 555 0001',
      etatCivil: 'Mariée', occupation: 'Commerçante', nomPartenaire: 'Jean Kabila', occupationPartenaire: 'Enseignant',
      contactUrgence: { nom: 'Marie Kabila', lien: 'Mère', telephone: '+243 81 000 0000', adresse: 'Av. Kasa-Vubu 4, Kalamu' },
      groupeSanguin: 'O', rhesus: 'Négatif', tailleCm: 158, electrophoreseHb: 'AS',
      antecedents: {
        gestite: 3, parite: 2, atcdMedicaux: ['Hypertension artérielle (HTA)', 'Inventé'],
        atcdGynecoChirurgicaux: ['Césarienne'], atcdObstetricaux: ['Mort-né', 'Eutocie'],
        plusGrosPoidsNaissanceG: 4200, dernierAccouchement: '2024-05-02', testVihConnuLe: ilYa(30),
      },
    },
    grossesse: { datation: { methode: 'DDR', ddr: ilYa(140), ddrFiabilite: 'Fiable' } },
  });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  let d = await appel('medecinA', 'GET', `/patientes/${r.corps.numero}`);
  const p = d.corps.patiente;
  assert.equal(p.etatCivil, 'Mariée');
  assert.equal(p.rhesus, 'Négatif');
  assert.equal(p.tailleCm, 158);
  assert.deepEqual(p.antecedents.atcdMedicaux, ['Hypertension artérielle (HTA)'], 'valeur hors référentiel ignorée');
  assert.equal(p.antecedents.plusGrosPoidsNaissanceG, 4200);
  // Champs de la fiche papier : Occupation/H, Adresse/Tél du contact, Eutocie, Test connu.
  assert.equal(p.occupationPartenaire, 'Enseignant');
  assert.equal(p.contactUrgence.adresse, 'Av. Kasa-Vubu 4, Kalamu');
  assert.deepEqual(p.antecedents.atcdObstetricaux, ['Mort-né', 'Eutocie']);
  assert.equal(p.antecedents.testVihConnuLe, ilYa(30));
  const gid = d.corps.grossesses[0].id;

  const c = await appel('medecinA', 'POST', `/grossesses/${gid}/consultations`, {
    type: 'Première consultation prénatale',
    constantes: { taSystolique: 150, taDiastolique: 95, saO2: 97, frequenceRespiratoire: 18 },
    examenCpn: { signes: { proteinurie: true, oedemes: false, inconnu: true }, etatGeneral: 'Bon', perimetreBrachialCm: 24, presentation: 'Céphalique' },
    mesuresPreventives: { vat1: { reponse: true }, sp1: { reponse: true }, methodePf: { reponse: true, valeur: 'Implant' } },
    laboratoire: { hb: '10,5', tdrPalu: 'Négatif' },
    echographie: 'Grossesse évolutive',
    reference: { motifs: ['TA systolique > 140', 'Motif inventé'] },
  });
  assert.equal(c.status, 201, JSON.stringify(c.corps));
  assert.equal(c.corps.examenCpn.signes.proteinurie, true);
  assert.equal(c.corps.examenCpn.signes.oedemes, false);
  assert.equal(c.corps.examenCpn.signes.goitre, null, 'non évalué');
  assert.ok(!('inconnu' in c.corps.examenCpn.signes));
  assert.equal(c.corps.constantes.saO2, 97);
  assert.equal(c.corps.laboratoire.hb, '10,5');
  assert.deepEqual(c.corps.reference.motifs, ['TA systolique > 140']);
  assert.ok(c.corps.reference.le, 'référence horodatée par le serveur');
  const horodatage = c.corps.reference.le;

  // L'horodatage est conservé tant que des motifs restent cochés.
  const m = await appel('medecinA', 'PATCH', `/consultations/${c.corps.id}`, { reference: { motifs: ['TA systolique > 140', 'Goitre'] }, finaliser: true });
  assert.equal(m.status, 200, JSON.stringify(m.corps));
  assert.equal(m.corps.reference.le, horodatage);

  d = await appel('medecinA', 'GET', `/patientes/${r.corps.numero}`);
  const mesures = d.corps.grossesses[0].mesuresPreventives;
  assert.deepEqual(Object.keys(mesures).sort(), ['methodePf', 'sp1', 'vat1']);
  assert.equal(mesures.methodePf.valeur, 'Implant');
  assert.ok(d.corps.consultations[0].reference.le);
});

test('deuxième grossesse : même dossier et même compte, historique des grossesses et des CPN conservé', async () => {
  const email = 'deux.grossesses@essai.test';
  const r = await creer('medecinA', {
    patiente: { ...patiente, nom: 'Mbuyi', prenom: 'Ruth', telephone: '+243 89 111 2233', email },
    grossesse: { datation: { methode: 'DDR', ddr: ilYa(200), ddrFiabilite: 'Fiable' } },
  });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  let d = await appel('medecinA', 'GET', `/patientes/${r.corps.numero}`);
  const g1 = d.corps.grossesses[0].id;
  const c1 = await appel('medecinA', 'POST', `/grossesses/${g1}/consultations`, { type: 'Première consultation prénatale', mesuresPreventives: { vat1: { reponse: true } }, finaliser: true });
  assert.equal(c1.status, 200, JSON.stringify(c1.corps));

  // Grossesse en cours : pas de seconde grossesse tant que l'issue n'est pas enregistrée.
  assert.equal((await appel('medecinA', 'POST', `/patientes/${r.corps.numero}/grossesses`, {})).status, 409);
  assert.equal((await appel('medecinA', 'POST', `/grossesses/${g1}/issue`, { issue: 'Naissance vivante', date: ilYa(10), mode: 'Voie basse' })).status, 200);

  // Réinscription avec le même e-mail : refusée, le dossier existant est désigné.
  const re = await creer('medecinB', { patiente: { ...patiente, nom: 'Mbuyi', prenom: 'Ruth', email }, confirmerMalgreDoublons: true });
  assert.equal(re.status, 409);
  assert.equal(re.corps.emailExistant, true);
  assert.equal(re.corps.doublons[0].numero, r.corps.numero);

  const n = await appel('medecinB', 'POST', `/patientes/${r.corps.numero}/grossesses`, { datation: { methode: 'DDR', ddr: ilYa(30), ddrFiabilite: 'Fiable' } });
  assert.equal(n.status, 201, JSON.stringify(n.corps));
  assert.equal(n.corps.numero, 2);
  const c2 = await appel('medecinB', 'POST', `/grossesses/${n.corps.id}/consultations`, { type: 'Première consultation prénatale', finaliser: true });
  assert.equal(c2.status, 200, 'nouvelle première CPN permise pour la nouvelle grossesse');

  d = await appel('medecinA', 'GET', `/patientes/${r.corps.numero}`);
  assert.equal(d.corps.patiente.statut, 'Suivi prénatal');
  assert.deepEqual(d.corps.grossesses.map((g) => [g.numero, g.statut]), [[2, 'En cours'], [1, 'Terminée']]);
  assert.equal(d.corps.grossesses[1].issue.issue, 'Naissance vivante');
  assert.ok(d.corps.grossesses[1].mesuresPreventives.vat1, 'mesures de la 1re grossesse conservées');
  assert.ok(!d.corps.grossesses[0].mesuresPreventives.vat1, 'la 2e grossesse repart de zéro');
  assert.deepEqual(d.corps.consultations.map((c) => c.grossesseId).sort(), [g1, n.corps.id].sort());
  const Patiente = require('../models/Patiente');
  assert.equal(await Patiente.countDocuments({ email }), 1, 'un seul compte');
});

test('échographie : rubriques de la fiche, fœtus multiples, compte rendu PDF privé ; médecins seulement', async () => {
  const r = await creer('medecinA', {
    patiente: { nom: 'Echo', prenom: 'Grace', ageDeclare: 27, telephone: '+243 81 444 0001', adresse: { province: 'Kinshasa' } },
    grossesse: { datation: { methode: 'DDR', ddr: ilYa(150) } },
  });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  let d = await appel('medecinA', 'GET', `/patientes/${r.corps.numero}`);
  const gid = d.corps.grossesses[0].id;

  const echo = (qui, donnees, fichiers = []) => {
    const f = new FormData();
    f.append('donnees', JSON.stringify(donnees));
    for (const x of fichiers) f.append('fichiers', new Blob([x.contenu ?? 'pdf'], { type: x.type }), x.nom);
    return fetch(`${api}/grossesses/${gid}/echographies`, { method: 'POST', headers: { Authorization: `Bearer ${jetons[qui]}` }, body: f })
      .then(async (x) => ({ status: x.status, corps: JSON.parse((await x.text()) || 'null') }));
  };
  const donnees = {
    date: ilYa(2), motif: 'Échographie du 2e trimestre', agSemaines: 21, agJours: 3, nombreFoetus: 2,
    foetus: [
      { activiteCardiaque: true, bcf: 142, sexe: 'Féminin', presentation: 'Céphalique', position: 'Dos à gauche', bipMm: 51, perimetreCranienMm: 190, perimetreAbdominalMm: 165, longueurFemoraleMm: 36, poidsEstimeG: 410 },
      { activiteCardiaque: true, sexe: 'Masculin', presentation: 'Siège', sexeInconnu: 'ignoré', poidsEstimeG: 395 },
      { activiteCardiaque: false, sexe: 'Féminin' },
    ],
    placenta: { localisation: 'Antérieur', aspect: 'Homogène', maturite: 'Grade I' },
    liquideAmniotique: { quantite: 'Normale', indiceCm: 14 },
    col: { longueurMm: 38, aspect: 'Fermé' },
    anomalies: '', conclusion: 'Grossesse gémellaire évolutive', praticien: 'Dr Mbuyi (radiologue)',
  };

  assert.equal((await echo('infirmiere', donnees)).status, 403, 'infirmière refusée');
  assert.equal((await echo('medecinA', { ...donnees, date: '2099-01-01' })).status, 400, 'date future refusée');
  assert.equal((await echo('medecinA', donnees, [{ type: 'text/plain', nom: 'cr.txt' }])).status, 400, 'format refusé');

  const envoisAvant = r2Appels.envoyes.length;
  const e = await echo('medecinA', donnees, [{ type: 'application/pdf', nom: 'compte-rendu.pdf' }, { type: 'image/png', nom: 'image.png', contenu: PNG }]);
  assert.equal(e.status, 201, JSON.stringify(e.corps));
  assert.equal(e.corps.foetus.length, 2, 'limité au nombre de fœtus déclaré');
  assert.equal(e.corps.foetus[0].bcf, 142);
  assert.equal(e.corps.foetus[1].bcf, null, 'BCF non renseigné');
  assert.equal(e.corps.foetus[1].sexe, 'Masculin');
  assert.equal(e.corps.foetus[1].poidsEstimeG, 395);
  assert.equal(e.corps.placenta.maturite, 'Grade I');
  assert.equal(e.corps.auteur.id, comptes.medecinA.id);
  assert.equal(r2Appels.envoyes.length - envoisAvant, 2);
  assert.ok(r2Appels.envoyes.at(-2).cle.startsWith('echographie/'));
  assert.ok(e.corps.fichiers.every((f) => f.url.includes('X-Amz-Expires') && !('cle' in f)), 'liens signés, clés jamais exposées');

  const l = await appel('medecinB', 'GET', `/grossesses/${gid}/echographies`);
  assert.equal(l.status, 200);
  assert.equal(l.corps.length, 1);
  d = await appel('medecinA', 'GET', `/patientes/${r.corps.numero}`);
  assert.equal(d.corps.echographies[0].conclusion, 'Grossesse gémellaire évolutive');
  const JournalAudit = require('../models/JournalAudit');
  assert.ok(await JournalAudit.exists({ action: 'echographie.creation', 'acteur.id': comptes.medecinA.id }));

  // Suppression du dossier : comptes rendus et images retirés du bucket.
  const cles = r2Appels.envoyes.slice(envoisAvant).map((x) => x.cle);
  assert.equal((await appel('chef', 'DELETE', `/patientes/${r.corps.numero}`, { confirmation: r.corps.numero })).status, 204);
  assert.ok(cles.every((c) => r2Appels.supprimes.includes(c)));
});

test('hors connexion : enregistrement CPN avec la 1re consultation, renvoyé deux fois → un seul dossier', async () => {
  const donnees = {
    patiente: {
      nom: 'Hors', prenom: 'Ligne', dateNaissance: '1996-05-02', telephone: '+243 81 777 0001', email: 'horsligne@essai.test',
      adresse: { province: 'Kinshasa', commune: 'Lemba', quartier: 'Salongo' },
    },
    grossesse: { datation: { methode: 'DDR', ddr: ilYa(84), ddrFiabilite: 'Fiable' } },
    compte: { motDePasse: 'Grossesse2026' },
    confirmerMalgreDoublons: true,
    // Saisie faite sans réseau il y a 3 heures : la consultation garde l'heure réelle.
    premiereConsultation: {
      date: new Date(Date.now() - 3 * 3600000).toISOString(),
      mesuresPreventives: { vat1: { reponse: true } }, laboratoire: { hb: '11,2' },
    },
  };
  const envoyer = async () => {
    const f = new FormData();
    f.append('donnees', JSON.stringify(donnees));
    f.append('photo', new Blob([PNG], { type: 'image/png' }), 'photo.png');
    const r = await fetch(`${api}/patientes`, { method: 'POST', headers: { Authorization: `Bearer ${jetons.medecinA}`, 'X-Operation-Id': 'op-essai-cpn-hors-ligne-1' }, body: f });
    return { status: r.status, corps: await r.json() };
  };
  const a = await envoyer();
  assert.equal(a.status, 201, JSON.stringify(a.corps));
  assert.ok(a.corps.consultationId, '1re CPN créée dans la même requête');
  const b = await envoyer(); // réseau coupé pendant la réponse : la synchronisation renvoie la même saisie
  assert.equal(b.status, 201);
  assert.equal(b.corps.numero, a.corps.numero, 'réponse rejouée, pas de second dossier');

  const Patiente = require('../models/Patiente');
  const Consultation = require('../models/Consultation');
  assert.equal(await Patiente.countDocuments({ email: 'horsligne@essai.test' }), 1);
  const consultations = await Consultation.find({ patienteId: a.corps.id });
  assert.equal(consultations.length, 1);
  assert.equal(consultations[0].statut, 'Brouillon');
  assert.equal(consultations[0].type, 'Première consultation prénatale');
  assert.ok(Date.now() - consultations[0].date.getTime() > 2.9 * 3600000, 'heure réelle de la saisie');
  assert.equal(consultations[0].laboratoire.hb, '11,2');

  // Consultation invalide : rien n'est créé (ni patiente ni consultation).
  const invalide = structuredClone(donnees);
  invalide.patiente.email = 'invalide@essai.test';
  invalide.premiereConsultation.date = new Date(Date.now() + 86400000).toISOString();
  const f = new FormData();
  f.append('donnees', JSON.stringify(invalide));
  f.append('photo', new Blob([PNG], { type: 'image/png' }), 'photo.png');
  const r = await fetch(`${api}/patientes`, { method: 'POST', headers: { Authorization: `Bearer ${jetons.medecinA}` }, body: f });
  assert.equal(r.status, 400);
  assert.equal(await Patiente.countDocuments({ email: 'invalide@essai.test' }), 0);
});
