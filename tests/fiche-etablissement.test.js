// Fiche AMI d'un établissement (étapes 1 à 10) : saisie par le comité, compléments facultatifs du
// médecin chef, calculs, circuit de validation et ouverture des modules (base en mémoire, données
// fictives). Lancer : npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');

let serveurMongo;
let api;
let http;
let mongoose;
const jetons = {};
const MDP = 'Comite#Pilotage2026';
let idEtab;

async function appel(qui, methode, chemin, corps) {
  const r = await fetch(`${api}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', ...(jetons[qui] ? { Authorization: `Bearer ${jetons[qui]}` } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  return { status: r.status, corps: r.status === 204 ? null : await r.json() };
}

async function formulaire(qui, methode, chemin, champs) {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  const r = await fetch(`${api}${chemin}`, { method: methode, headers: { Authorization: `Bearer ${jetons[qui]}` }, body: f });
  return { status: r.status, corps: await r.json() };
}

const service = (nom, fonctionnel = 'Oui') => ({ service: nom, autorise: 'Oui', disponible: 'Oui', fonctionnel, personnelQualifie: 'Oui', equipement: 'Disponible', joursActivite: 5 });

const fiche = () => ({
  identification: { codeSnis: 'SNIS-001', nomUsuel: 'CS Nyemba', sigle: 'CSN', niveauSanitaire: 'Aire', statutActuel: 'Fonctionnelle', anneeCreation: 1998 },
  localisation: { territoire: 'Kalemie', commune: 'Lac', accessibilitePluies: 'Partielle' },
  organisation: {
    statutJuridique: 'Confessionnel', modeGestion: 'Confessionnelle',
    responsable: { nom: 'KABILA', postnom: 'FICTIF', prenom: 'Jean', fonction: 'Infirmier titulaire', telephone: '+243 000' },
  },
  services: [service('CPN'), service('Accouchement'), service('Vaccination', 'Non'), service('Laboratoire', 'Partiel')],
});

const etablissement = (nom) => ({
  nom, type: 'Centre de santé', province: 'Tanganyika', zonesSante: ['Kalemie'], aireSante: 'Nyemba',
  adresse: 'Avenue fictive', telephone: '+243 000', fiche: fiche(),
});
const chef = (email) => ({
  prenom: 'Clarisse', nom: 'CHEF', postnom: 'TEST', sexe: 'F', dateNaissance: '1980-05-01', lieuNaissance: 'Kalemie',
  nationalite: 'Congolaise', pieceType: 'Passeport', adresse: 'Fictive', telephone: '+243 81 000 0000',
  grade: 'Médecin spécialiste', specialite: 'Gynécologie-obstétrique', email,
});

before(async () => {
  serveurMongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = serveurMongo.getUri('ami_connecte_essai');
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  const app = require('../app');
  mongoose = require('mongoose');
  await mongoose.connection.asPromise();
  const bcrypt = require('bcrypt');
  const MembreComite = require('../models/MembreComite');
  const hash = await bcrypt.hash(MDP, 4);
  await MembreComite.create({ prenom: 'Paul', nom: 'SAISIE', email: 'saisie@essai.test', motDePasse: hash });
  await MembreComite.create({ prenom: 'Marie', nom: 'VERIF', email: 'verif@essai.test', motDePasse: hash });
  http = app.listen(0);
  await new Promise((r) => http.once('listening', r));
  api = `http://127.0.0.1:${http.address().port}/api`;
  for (const [qui, email] of [['saisie', 'saisie@essai.test'], ['verif', 'verif@essai.test']]) {
    jetons[qui] = (await appel(null, 'POST', '/comite/connexion', { email, motDePasse: MDP })).corps.jeton;
  }
});

after(async () => {
  http?.close();
  await mongoose?.disconnect();
  await serveurMongo?.stop();
});

test('création avec la fiche AMI : code AMI, champs déduits, brouillon', async () => {
  const r = await formulaire('saisie', 'POST', '/comite/etablissements', { ...etablissement('Centre de Santé Nyemba'), medecinChef: chef('chef.nyemba@essai.test') });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  const e = r.corps.etablissement;
  idEtab = e.id;
  assert.match(e.codeAmi, /^AMI-TAN-KAL-\d{5}$/);
  assert.equal(e.secteur, 'Confessionnel', 'secteur déduit du statut juridique');
  assert.equal(e.responsable, 'Jean KABILA FICTIF');
  assert.deepEqual(e.services.sort(), ['CPN', 'Laboratoire', 'Maternité'].sort(), 'services déduits de l’étape 6');
  assert.equal(e.ficheAmi.statut, 'Brouillon');
  assert.ok(!('fiche' in e), 'fiche complète jamais dans les listes');

  const c = await fetch(`${api}/auth/connexion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'chef.nyemba@essai.test', motDePasse: r.corps.motDePasseTemporaire }) });
  jetons.chef = (await c.json()).jeton;

  const f = await appel('saisie', 'GET', `/comite/etablissements/${idEtab}/fiche`);
  assert.equal(f.status, 200);
  assert.equal(f.corps.fiche.identification.categorie, 'CS', 'catégorie proposée selon le type');
  assert.equal(f.corps.rattachement.bczs, 'BCZS Kalemie');
  assert.equal(f.corps.rattachement.dps, 'DPS Tanganyika');
  assert.deepEqual(f.corps.calculs.modulesPrevus, ['CPN', 'Accouchement']);
  assert.deepEqual(f.corps.calculs.modulesActifs, [], 'aucun module avant activation');
});

test('cascade : une aire déjà rattachée à une autre zone est refusée', async () => {
  const r = await formulaire('saisie', 'POST', '/comite/etablissements', {
    ...etablissement('Poste Nyemba bis'), zonesSante: ['Nyemba'], medecinChef: chef('chef.bis@essai.test'),
  });
  assert.equal(r.status, 400, JSON.stringify(r.corps));
  assert.match(r.corps.message, /appartient à la zone de santé Kalemie/);
});

test('médecin chef : complète les champs facultatifs, pas les champs du comité', async () => {
  const interdit = await appel('chef', 'PATCH', `/etablissements/${idEtab}/fiche`, { identification: { codeSnis: 'PIRATE' } });
  assert.equal(interdit.status, 403);
  assert.equal((await appel('chef', 'PATCH', `/etablissements/${idEtab}/fiche`, { services: [] })).status, 403);

  const r = await appel('chef', 'PATCH', `/etablissements/${idEtab}/fiche`, {
    identification: { siteWeb: 'https://exemple.test' },
    infrastructures: { litsTotal: 20, litsFonctionnels: 15, chaineFroid: 'Oui' },
    equipements: [{ nom: 'Tensiomètre', total: 4, fonctionnels: 3, enPanne: 1, horsService: 0 }],
    agents: [
      { nom: 'A', profession: 'Infirmier', service: 'CPN' },
      { nom: 'B', profession: 'Sage-femme', service: 'Maternité', disponibilite: 'Indisponible' },
    ],
    effectifsAttendus: [{ profession: 'Sage-femme', nombre: 3 }],
    populations: [{ annee: 2026, totale: 20000, hommes: 9800, femmes: 10200 }],
    capacites: { accouchementsMois: 30, cpnMois: 400, personnelQualifie: 'Oui', eau: 'Oui' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  const k = r.corps.calculs;
  assert.equal(k.equipements.taux, 75, 'taux de fonctionnalité = 3/4');
  assert.equal(k.rh.total, 2);
  assert.equal(k.rh.indisponibles, 1);
  assert.deepEqual(k.rh.ecarts, [{ profession: 'Sage-femme', attendu: 3, present: 1, ecart: -2 }]);
  const [fe, na, ns] = k.cibles.lignes;
  assert.equal(fe.cibleAnnuelle, 800);
  assert.equal(fe.cibleMensuelle, 67);
  assert.equal(na.cibleAnnuelle, 800);
  assert.equal(ns.cibleAnnuelle, 698);
  const acc = k.capacites.lignes.find((l) => l.service === 'Accouchement');
  assert.equal(acc.besoin, 67);
  assert.equal(acc.deficit, 37);
  assert.equal(acc.alerte.niveau, 'rouge');
  assert.equal(r.corps.fiche.circuit.statut, 'Brouillon', 'la saisie du chef ne change pas le statut');

  // Données nominatives : jamais servies au reste du personnel ni dans les listes.
  const liste = await appel('chef', 'GET', '/etablissements');
  assert.ok(!liste.corps.some((e) => 'fiche' in e));
});

test('population : une année = un enregistrement, les anciennes sont conservées', async () => {
  const r = await appel('chef', 'PATCH', `/etablissements/${idEtab}/fiche`, { populations: [{ annee: 2027, totale: 20600 }] });
  assert.deepEqual(r.corps.fiche.populations.map((p) => p.annee), [2026, 2027]);
  assert.equal(r.corps.calculs.cibles.annee, 2027);
});

test('changement de responsable : historique conservé', async () => {
  const r = await appel('saisie', 'PATCH', `/comite/etablissements/${idEtab}/fiche`, {
    organisation: { responsable: { nom: 'MUKENDI', prenom: 'Anne', fonction: 'Médecin directeur', telephone: '+243 111' } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  const h = r.corps.fiche.historiqueResponsables;
  assert.equal(h.length, 1);
  assert.equal(h[0].ancien.nom, 'KABILA');
  assert.equal(h[0].nouveau.nom, 'MUKENDI');
  assert.equal(r.corps.etablissement.responsable, 'Anne MUKENDI');
});

test('circuit : vérificateur ≠ auteur, pas d’activation sans validation, modules ouverts selon l’étape 6', async () => {
  const chemin = (a) => `/comite/etablissements/${idEtab}/fiche/circuit/${a}`;
  assert.equal((await appel('saisie', 'POST', chemin('activer'))).status, 409, 'pas d’activation d’un brouillon');

  // Module CPN fermé tant que la fiche n'est pas active.
  const Etablissement = require('../models/Etablissement');
  const { modulesActifs } = require('../config/ficheEtablissement');
  assert.deepEqual(modulesActifs(await Etablissement.findById(idEtab)), []);

  const s = await appel('saisie', 'POST', chemin('soumettre'));
  assert.equal(s.status, 200, JSON.stringify(s.corps));
  assert.equal(s.corps.fiche.circuit.statut, 'En attente de vérification');

  const auteur = await appel('saisie', 'POST', chemin('verifier'), { nom: 'Paul', fonction: 'MCZ', date: '2026-11-12', resultat: 'Conforme' });
  assert.equal(auteur.status, 403, 'l’auteur ne vérifie pas sa propre saisie');

  const nc = await appel('verif', 'POST', chemin('verifier'), { nom: 'Marie', fonction: 'MCZ', date: '2026-11-12', resultat: 'Non conforme', motifs: ['GPS manquant'] });
  assert.equal(nc.corps.fiche.circuit.statut, 'À corriger');
  assert.deepEqual(nc.corps.fiche.circuit.motifsCorrection, ['GPS manquant']);

  await appel('saisie', 'PATCH', `/comite/etablissements/${idEtab}/fiche`, { localisation: { reperes: 'Près du marché' } });
  assert.equal((await appel('saisie', 'POST', chemin('soumettre'))).status, 200);
  const ok = await appel('verif', 'POST', chemin('verifier'), { nom: 'Marie', fonction: 'MCZ', date: '2026-11-12', resultat: 'Conforme' });
  assert.equal(ok.corps.fiche.circuit.statut, 'En attente de validation');
  const v = await appel('verif', 'POST', chemin('valider'), { nom: 'Dr Valideur', date: '2026-11-12' });
  assert.equal(v.corps.fiche.circuit.statut, 'Validée');
  const a = await appel('verif', 'POST', chemin('activer'));
  assert.equal(a.corps.fiche.circuit.statut, 'Active');
  assert.match(a.corps.fiche.circuit.qrCode, /^data:image\/png;base64,/);
  assert.deepEqual(a.corps.calculs.modulesActifs, ['CPN', 'Accouchement'], 'vaccination non fonctionnelle : module fermé');
});

test('contrôle automatique : champs obligatoires manquants bloquent la soumission', async () => {
  const r = await formulaire('saisie', 'POST', '/comite/etablissements', {
    ...etablissement('Centre incomplet'), aireSante: 'Kataki', fiche: { ...fiche(), identification: { niveauSanitaire: 'Aire', codeSnis: 'SNIS-001' } },
    medecinChef: chef('chef.incomplet@essai.test'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  const s = await appel('saisie', 'POST', `/comite/etablissements/${r.corps.etablissement.id}/fiche/circuit/soumettre`);
  assert.equal(s.status, 422);
  assert.ok(s.corps.erreurs.some((m) => /Statut actuel/.test(m)));
  assert.ok(s.corps.erreurs.some((m) => /SNIS-001 est déjà attribué/.test(m)), 'doublon de code SNIS bloquant');
});

test('établissement antérieur à la fiche : modules non restreints', async () => {
  const Etablissement = require('../models/Etablissement');
  const { modulesActifs } = require('../config/ficheEtablissement');
  const e = await Etablissement.create({
    nom: 'Ancien centre', code: 'ETS-TAN-9999', type: 'Centre de santé', secteur: 'Public', province: 'Tanganyika',
    zonesSante: ['Kalemie'], adresse: 'x', telephone: '+243 000', responsable: 'x', services: ['CPN'],
  });
  assert.equal(modulesActifs(e), null);
  assert.match(e.codeAmi, /^AMI-TAN-KAL-/);
  const r = await appel('saisie', 'PATCH', `/comite/etablissements/${e.id}/fiche`, { capacites: { accueil: 10 } });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.equal(r.corps.calculs.modulesActifs, null, 'fiche ouverte sur un établissement existant : rien n’est bloqué');
});
