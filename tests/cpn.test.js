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
  const dpaAttendue = new Date(Date.parse(`${ddr}T00:00:00Z`) + 280 * 86400000).toISOString().slice(0, 10);
  assert.equal(g.datation.dpa, dpaAttendue, 'DPA = DDR + 280 jours');
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
  const { lienDossier } = require('../controllers/carte');
  assert.equal(lienDossier('AC-PAT-000001'), 'http://localhost:4200/admin/patientes/AC-PAT-000001', 'le QR ne contient que le lien du dossier');
});

test('infirmière : suivi en lecture seule (grossesse en cours et rendez-vous), sans données sensibles', async () => {
  // Patiente avec facteur de risque, antécédents et consultation : rien de cela ne doit apparaître.
  const r = await creer('medecinA', {
    patiente: { nom: 'Suivi', prenom: 'Infirmiere', ageDeclare: 28, telephone: '+243 81 777 0001', adresse: { province: 'Kinshasa' },
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
  const texte = JSON.stringify(s.corps);
  for (const sensible of ['Hypertension', 'Pénicilline', 'Drépanocytose', 'Céphalées', 'antecedents', 'facteursRisque', 'consultations', 'email', 'datation']) {
    assert.ok(!texte.includes(sensible), `« ${sensible} » réservé aux médecins`);
  }

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
