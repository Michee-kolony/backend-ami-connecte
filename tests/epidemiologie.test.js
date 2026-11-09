// Tests d'acceptation du module Épidémiologie (cahier des charges, Partie IV : T01 à T20).
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
const AN = new Date().getFullYear();
const AUJ = new Date().toISOString().slice(0, 10);
const MOIS = AUJ.slice(0, 7);
let compteur = 0;

async function appel(qui, methode, chemin, corps, entetes = {}) {
  const r = await fetch(`${api}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jetons[qui]}`, ...entetes },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const type = r.headers.get('content-type') || '';
  if (!type.includes('json')) return { status: r.status, type, texte: Buffer.from(await r.arrayBuffer()) };
  const texte = await r.text();
  return { status: r.status, corps: texte ? JSON.parse(texte) : null };
}
const ok = (r, attendu = 200) => assert.equal(r.status, attendu, JSON.stringify(r.corps));

/** Soumission (auteur) puis validation par un autre utilisateur (séparation des rôles). */
async function soumettreEtValider(type, id, auteur = 'chef', validateur = 'directeur') {
  ok(await appel(auteur, 'POST', `/epidemiologie/donnees/${type}/${id}/soumettre`));
  const r = await appel(validateur, 'POST', `/epidemiologie/donnees/${type}/${id}/decision`, { decision: 'valider' });
  ok(r);
  return r.corps;
}

before(async () => {
  serveurMongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = serveurMongo.getUri('ami_connecte_essai_epidemiologie');
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  const app = require('../app');
  mongoose = require('mongoose');
  await mongoose.connection.asPromise();
  const jwt = require('jsonwebtoken');
  const Etablissement = require('../models/Etablissement');
  const Soignant = require('../models/Soignant');
  const Patiente = require('../models/Patiente');
  const etab = (code, nom) => Etablissement.create({
    code, nom, type: 'Centre de santé', secteur: 'Public', province: 'Kinshasa', zoneSante: 'Zone Essai', aireSante: 'Aire Essai',
    adresse: 'Fictive', telephone: '000', responsable: 'Fictif', services: ['CPN', 'Vaccination'],
  });
  const csA = await etab('ETS-KIN-9801', 'CS Épidémio A');
  const csB = await etab('ETS-KIN-9802', 'CS Épidémio B');
  ids.csA = csA.id;
  ids.csB = csB.id;
  const base = {
    postnom: 'TEST', sexe: 'F', dateNaissance: '1985-01-01', lieuNaissance: 'Kinshasa', nationalite: 'Congolaise',
    pieceType: 'Passeport', adresse: 'Fictive', telephone: '000', grade: 'Fictif', specialite: 'Fictive', motDePasse: 'x',
  };
  const soignant = async (cle, role, etablissementId, matricule) => {
    const s = await Soignant.create({ ...base, prenom: cle, nom: 'EPI', role, matricule, email: `${cle}@epi.test`, affectations: [{ etablissementId }] });
    ids[cle] = s.id;
    jetons[cle] = jwt.sign({ sub: s.id, etablissement: etablissementId }, process.env.JWT_SECRET, { expiresIn: '10m' });
  };
  await soignant('chef', 'Médecin chef de service', csA.id, 'MED-9801');
  await soignant('directeur', 'Médecin directeur', csA.id, 'MED-9802');
  await soignant('titulaire', 'Infirmier(ère) titulaire', csA.id, 'INF-9801');
  await soignant('infirmiere', 'Infirmier(ère)', csA.id, 'INF-9802');

  // Activité observée dans les modules AMI (CPN et vaccination) : une femme en CPN1 et un enfant Penta1 dans chaque CS.
  const auteur = { id: ids.chef, nom: 'Chef EPI', role: 'Médecin chef de service' };
  for (const [i, e] of [[1, csA], [2, csB]]) {
    const p = await Patiente.create({ numero: `AC-PAT-98000${i}`, nom: 'Essai', prenom: `Femme${i}`, telephone: '000', etablissementId: e.id, adresse: { province: 'Kinshasa' }, creePar: auteur });
    ids[`patiente${i}`] = p.id;
    const g = new mongoose.Types.ObjectId();
    await mongoose.connection.collection('consultations').insertOne({ patienteId: p._id, grossesseId: g, date: new Date(`${MOIS}-01T10:00:00Z`), statut: 'Finalisée', type: 'Première consultation prénatale' });
    await mongoose.connection.collection('enfants').insertOne({
      numero: `AC-ENF-98000${i}`, mereId: p._id, etablissementId: e.id, sexe: 'Féminin', dateNaissance: `${AN - 1}-06-01`, neLe: new Date(`${AN - 1}-06-01T08:00:00Z`),
      etatNaissance: 'Vivant', statut: 'Suivi', suivis: [], vaccinations: [{ code: 'penta1', date: `${MOIS}-01`, administreePar: auteur, le: new Date() }], createdAt: new Date(), updatedAt: new Date(),
    });
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

test('Référentiel géographique : synchronisé depuis les établissements, codes uniques', async () => {
  const r = await appel('chef', 'POST', '/epidemiologie/territoires/synchroniser');
  ok(r);
  assert.ok(r.corps.creees >= 5);
  const t = (await appel('infirmiere', 'GET', '/epidemiologie/territoires')).corps;
  const fosa = t.find((e) => e.etablissementId === ids.csA);
  assert.equal(fosa.niveau, 'Formation sanitaire');
  ids.fosaA = fosa.code;
  ids.aire = t.find((e) => e.niveau === 'Aire de santé').code;
  ids.zone = t.find((e) => e.niveau === 'Zone de santé').code;
  // Une deuxième synchronisation ne crée pas de doublon.
  assert.equal((await appel('chef', 'POST', '/epidemiologie/territoires/synchroniser')).corps.creees, 0);
  const refus = await appel('infirmiere', 'POST', '/epidemiologie/territoires', { niveau: 'Communauté', nom: 'Quartier', parentCode: ids.aire });
  assert.equal(refus.status, 403);
});

test('T01-T02 : population enregistrée avec identifiant unique ; incohérence par sexe signalée et bloquante', async () => {
  const tranches = [['0-0', 3500], ['1-4', 14000], ['5-9', 14500], ['10-14', 12000], ['15-19', 11000], ['20-24', 9000], ['25-49', 26000], ['50-59', 5500], ['60+', 4500]]
    .map(([code, effectif]) => ({ code, effectif }));
  const r = await appel('titulaire', 'POST', '/epidemiologie/populations', {
    entiteCode: ids.aire, annee: AN, totale: 100000, hommes: 48000, femmes: 52000, tranchesAge: tranches,
    source: 'Projection', methode: 'Projection', nature: 'Projetée', dateDisponibilite: `${AN}-01-15`, document: 'Projection INS',
  });
  ok(r, 201);
  assert.ok(r.corps.id);
  assert.deepEqual(r.corps.anomalies, []);
  assert.equal(r.corps.proportionHommes, 48);
  ids.popAire = r.corps.id;
  // Même entité, même année : refusé (une seule population active).
  assert.equal((await appel('titulaire', 'POST', '/epidemiologie/populations', { entiteCode: ids.aire, annee: AN, totale: 1, hommes: 1, femmes: 0, source: 'Autre', methode: 'Estimation', dateDisponibilite: AUJ })).status, 409);

  const inc = await appel('titulaire', 'POST', '/epidemiologie/populations', {
    entiteCode: ids.zone, annee: AN, totale: 75000, hommes: 36000, femmes: 30000, source: 'Estimation officielle', methode: 'Estimation', dateDisponibilite: AUJ,
  });
  ok(inc, 201);
  assert.ok(inc.corps.anomalies.some((a) => a.startsWith('Hommes + femmes')));
  ok(await appel('titulaire', 'POST', `/epidemiologie/donnees/population/${inc.corps.id}/soumettre`));
  const refus = await appel('directeur', 'POST', `/epidemiologie/donnees/population/${inc.corps.id}/decision`, { decision: 'valider' });
  assert.equal(refus.status, 422);
  // Rejet : motif obligatoire.
  assert.equal((await appel('directeur', 'POST', `/epidemiologie/donnees/population/${inc.corps.id}/decision`, { decision: 'rejeter' })).status, 400);
  ok(await appel('directeur', 'POST', `/epidemiologie/donnees/population/${inc.corps.id}/decision`, { decision: 'corriger', motif: 'Répartition par sexe incohérente' }));

  // Validation de la population de l'aire ; l'auteur ne peut pas valider sa propre saisie.
  ok(await appel('titulaire', 'POST', `/epidemiologie/donnees/population/${ids.popAire}/soumettre`));
  const v = await appel('directeur', 'POST', `/epidemiologie/donnees/population/${ids.popAire}/decision`, { decision: 'valider' });
  ok(v);
  assert.equal(v.corps.statut, 'Validé');
});

test('T15 : accès refusé et journalisé (validation, paramétrage)', async () => {
  const pop = await appel('titulaire', 'POST', '/epidemiologie/populations', { entiteCode: ids.fosaA, annee: AN, totale: 20000, hommes: 9600, femmes: 10400, source: 'Estimation officielle', methode: 'Estimation', dateDisponibilite: AUJ });
  ok(pop, 201);
  ok(await appel('titulaire', 'POST', `/epidemiologie/donnees/population/${pop.corps.id}/soumettre`));
  assert.equal((await appel('infirmiere', 'POST', `/epidemiologie/donnees/population/${pop.corps.id}/decision`, { decision: 'valider' })).status, 403);
  assert.equal((await appel('infirmiere', 'POST', '/epidemiologie/coefficients', { nom: 'X', cible: 'FE', valeurPct: 5, dateDebut: AUJ })).status, 403);
  // Séparation saisie / validation : le chef soumet, il ne peut pas valider lui-même.
  const autre = await appel('chef', 'POST', '/epidemiologie/populations', { entiteCode: ids.zone, annee: AN - 1, totale: 70000, hommes: 34000, femmes: 36000, source: 'Recensement', methode: 'Recensement', dateDisponibilite: AUJ });
  ok(autre, 201);
  ok(await appel('chef', 'POST', `/epidemiologie/donnees/population/${autre.corps.id}/soumettre`));
  assert.equal((await appel('chef', 'POST', `/epidemiologie/donnees/population/${autre.corps.id}/decision`, { decision: 'valider' })).status, 403);
  const journal = (await appel('chef', 'GET', '/epidemiologie/historique/journal')).corps;
  assert.ok(journal.some((e) => e.action === 'acces.refuse' && e.resultat === 'refusé'));
  ok(await appel('directeur', 'POST', `/epidemiologie/donnees/population/${pop.corps.id}/decision`, { decision: 'valider' }));
});

test('T03 : un coefficient validé modifié crée une nouvelle version (l’ancienne reste)', async () => {
  const liste = (await appel('chef', 'GET', '/epidemiologie/coefficients')).corps;
  assert.equal(liste.coefficients.length, 3);
  assert.ok(liste.coefficients.every((x) => x.statut === 'Brouillon'));
  // Aucun coefficient ne peut être activé sans source.
  const fe = liste.coefficients.find((x) => x.code === 'DEM-001');
  ok(await appel('chef', 'POST', `/epidemiologie/donnees/coefficient/${fe.id}/soumettre`));
  assert.equal((await appel('directeur', 'POST', `/epidemiologie/donnees/coefficient/${fe.id}/decision`, { decision: 'valider' })).status, 422);
  ok(await appel('directeur', 'POST', `/epidemiologie/donnees/coefficient/${fe.id}/decision`, { decision: 'corriger', motif: 'Source manquante' }));
  for (const x of liste.coefficients) {
    ok(await appel('chef', 'PATCH', `/epidemiologie/coefficients/${x.id}`, { source: 'Note PEV / Ministère de la Santé (essai)', dateDebut: `${AN}-01-01` }));
    await soumettreEtValider('coefficient', x.id);
  }
  const ns = liste.coefficients.find((x) => x.code === 'DEM-003');
  assert.equal(ns.valeurDecimale, 0.0349);
  // Modification sans motif : refusée ; avec motif : nouvelle version en brouillon.
  assert.equal((await appel('chef', 'PATCH', `/epidemiologie/coefficients/${fe.id}`, { valeurPct: 4.2 })).status, 400);
  const v2 = await appel('chef', 'PATCH', `/epidemiologie/coefficients/${fe.id}`, { valeurPct: 4.2, motif: 'Proposition de révision' });
  ok(v2);
  assert.equal(v2.corps.version, 2);
  assert.equal(v2.corps.statut, 'Brouillon');
  assert.notEqual(v2.corps.id, fe.id);
  const apres = (await appel('chef', 'GET', '/epidemiologie/coefficients')).corps;
  assert.equal(apres.coefficients.find((x) => x.id === fe.id).statut, 'Validé');
  assert.equal(apres.coefficients.find((x) => x.id === fe.id).valeurPct, 4);
  // Coefficient incompatible (même cible, même territoire, même période, autre code) : validation refusée.
  const concurrent = await appel('chef', 'POST', '/epidemiologie/coefficients', { nom: 'Femmes enceintes (bis)', cible: 'FE', valeurPct: 5, dateDebut: `${AN}-01-01`, source: 'Essai' });
  ok(concurrent, 201);
  ok(await appel('chef', 'POST', `/epidemiologie/donnees/coefficient/${concurrent.corps.id}/soumettre`));
  assert.equal((await appel('directeur', 'POST', `/epidemiologie/donnees/coefficient/${concurrent.corps.id}/decision`, { decision: 'valider' })).status, 409);
});

test('T04-T05 : populations cibles calculées avec les coefficients validés (formule, versions, arrondi)', async () => {
  const r = await appel('titulaire', 'POST', '/epidemiologie/cibles/calcul', { entiteCode: ids.aire, annee: AN });
  ok(r);
  const calcul = r.corps.resultats[0].calcul;
  const val = Object.fromEntries(calcul.resultats.map((x) => [x.cible, x]));
  assert.equal(val.FE.valeur, 4000);
  assert.equal(val.NA.valeur, 4000);
  assert.equal(val.NS.valeur, 3490);
  assert.equal(val.FE.coefficientCode, 'DEM-001');
  assert.equal(val.FE.coefficientVersion, 1);
  assert.match(val.NS.formule, /0,0349/);
  // Reproductible : même population, mêmes coefficients → calcul réutilisé.
  assert.equal((await appel('titulaire', 'POST', '/epidemiologie/cibles/calcul', { entiteCode: ids.aire, annee: AN })).corps.reutilises, 1);
  // Simulation (exemple du cahier : 75 000 hab. → 2 618 nourrissons survivants).
  const s = await appel('infirmiere', 'POST', '/epidemiologie/cibles/simulation', { populationTotale: 75000, entiteCode: ids.aire, annee: AN });
  ok(s);
  assert.equal(s.corps.resultats.find((x) => x.cible === 'NS').valeur, 2618);
  await soumettreEtValider('calcul', calcul.id, 'titulaire', 'directeur');
  ids.calcul = calcul.id;
  // FOSA A : calcul aussi validé (comparaison des structures).
  const f = await appel('titulaire', 'POST', '/epidemiologie/cibles/calcul', { entiteCode: ids.fosaA, annee: AN });
  await soumettreEtValider('calcul', f.corps.resultats[0].calcul.id, 'titulaire', 'directeur');
  const d = (await appel('chef', 'GET', `/epidemiologie/cibles/${ids.calcul}`)).corps;
  assert.equal(d.comparaison[0].variation, null);
  assert.ok(d.comparaison[0].raison);
});

test('T06 : la somme des objectifs mensuels correspond au total annuel', async () => {
  const { repartirUniforme } = require('../controllers/epidemiologie/planification');
  for (const n of [1000, 800, 4000, 3490, 7]) assert.equal(repartirUniforme(n).reduce((a, b) => a + b, 0), n);
  const r = await appel('titulaire', 'POST', '/epidemiologie/plans', { annee: AN, intervention: 'CPN1', entiteCode: ids.aire, responsable: 'IT de l’aire' });
  ok(r, 201);
  assert.equal(r.corps.cibleAnnuelle, 4000);
  assert.equal(r.corps.mensuel.reduce((a, b) => a + b, 0), 4000);
  assert.equal(r.corps.trimestriel.reduce((a, b) => a + b, 0), 4000);
  // Cible ajustée sans justification : refusée.
  assert.equal((await appel('titulaire', 'POST', '/epidemiologie/plans', { annee: AN, intervention: 'PENTA3', entiteCode: ids.aire, cibleAnnuelle: 3000 })).status, 400);
  // Répartition personnalisée dont la somme diffère : validation bloquée.
  const p = await appel('titulaire', 'POST', '/epidemiologie/plans', { annee: AN, intervention: 'PENTA3', entiteCode: ids.aire, repartition: 'Personnalisée',
    mensuel: [300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300], justification: 'Campagne de rattrapage' });
  ok(p, 201);
  ok(await appel('titulaire', 'POST', `/epidemiologie/donnees/plan/${p.corps.id}/soumettre`));
  assert.equal((await appel('directeur', 'POST', `/epidemiologie/donnees/plan/${p.corps.id}/decision`, { decision: 'valider' })).status, 422);
  await soumettreEtValider('plan', r.corps.id, 'titulaire', 'directeur');
  const suivi = await appel('chef', 'GET', `/epidemiologie/plans/${r.corps.id}/suivi`);
  ok(suivi);
  assert.equal(suivi.corps.realisationsCumulees, 2); // une CPN1 dans chaque CS (consolidation du chef)
  assert.equal(suivi.corps.cibleRestante, 3998);
});

test('T07-T08 : événement notifié une seule fois ; cas confirmé intégré aux analyses après validation', async () => {
  const entetes = { 'X-Operation-Id': 'op-epi-evenement-0001' };
  const corps = { type: 'Maladie', maladie: 'ROUGEOLE', dateDebut: AUJ, entiteCode: ids.aire, casSignales: 3, decesSignales: 0, description: 'Cas groupés d’éruption fébrile', priorite: 'Élevée' };
  const a = await appel('infirmiere', 'POST', '/epidemiologie/evenements', corps, entetes);
  ok(a, 201);
  assert.match(a.corps.numero, new RegExp(`^EVT-${AN}-\\d{6}$`));
  // Renvoi de la même saisie hors connexion (T17) : aucune deuxième notification.
  const b = await appel('infirmiere', 'POST', '/epidemiologie/evenements', corps, entetes);
  assert.equal(b.corps.numero, a.corps.numero);
  assert.equal((await appel('chef', 'GET', '/epidemiologie/evenements')).corps.length, 1);
  ids.evenement = a.corps.numero;

  const cas = await appel('infirmiere', 'POST', '/epidemiologie/cas', { evenementNumero: ids.evenement, sexe: 'Féminin', ageAnnees: 3, entiteCode: ids.aire, maladie: 'ROUGEOLE',
    dateDebutSymptomes: AUJ, classification: 'Confirmé', resultatLabo: 'Positif', personneNumero: 'AC-PAT-980001' });
  ok(cas, 201);
  ids.cas = cas.corps.id;
  // Doublon détecté avant consolidation.
  const doublon = await appel('infirmiere', 'POST', '/epidemiologie/cas', { sexe: 'Féminin', ageAnnees: 3, entiteCode: ids.aire, maladie: 'ROUGEOLE', dateDebutSymptomes: AUJ, classification: 'Suspect', personneNumero: 'AC-PAT-980001' });
  assert.equal(doublon.status, 409);
  let t = (await appel('chef', 'GET', `/epidemiologie/surveillance/tableau?dans=${ids.zone}&annee=${AN}`)).corps;
  assert.equal(t.resume.casValides, 0);
  assert.equal(t.resume.casNonValides, 1);
  ok(await appel('chef', 'POST', `/epidemiologie/donnees/cas/${ids.cas}/decision`, { decision: 'valider' }));
  t = (await appel('chef', 'GET', `/epidemiologie/surveillance/tableau?dans=${ids.zone}&annee=${AN}`)).corps;
  assert.equal(t.resume.casValides, 1);
  assert.equal(t.resume.confirmes, 1);
  assert.equal(t.maladies[0].variation, null); // aucune donnée la période précédente : non calculable
  assert.equal(t.courbe.length, 1);
  // Investigation : l'événement passe « En investigation ».
  const inv = await appel('titulaire', 'PUT', `/epidemiologie/evenements/${ids.evenement}/investigation`, { debut: AUJ, responsable: 'Épidémiologiste de zone', personnesExposees: 150 });
  ok(inv);
  assert.equal(inv.corps.etat, 'En investigation');
  const detail = (await appel('chef', 'GET', `/epidemiologie/evenements/${ids.evenement}`)).corps;
  assert.equal(detail.tauxAttaque.valeur, 0.7);
});

test('T09 : décès maternel suivi par le circuit de classification et de validation', async () => {
  const mauvais = await appel('infirmiere', 'POST', '/epidemiologie/deces', { dateDeces: AUJ, ageAnnees: 30, sexe: 'Masculin', lieu: 'Structure sanitaire', entiteCode: ids.aire,
    causeInitiale: 'Hémorragie obstétricale', maternel: 'Oui', source: 'Registre' });
  ok(mauvais, 201);
  assert.equal(mauvais.corps.statut, 'Soumis');
  assert.equal((await appel('chef', 'POST', `/epidemiologie/donnees/deces/${mauvais.corps.id}/decision`, { decision: 'valider' })).status, 422);
  const bon = await appel('infirmiere', 'POST', '/epidemiologie/deces', { dateDeces: AUJ, ageAnnees: 28, sexe: 'Féminin', lieu: 'Structure sanitaire', entiteCode: ids.aire,
    causeInitiale: 'Hémorragie obstétricale', maternel: 'Oui', neonatal: 'Non', source: 'Audit (SDMPR)' });
  ok(bon, 201);
  const controle = (await appel('chef', 'GET', `/epidemiologie/donnees/deces/${bon.corps.id}/controle`)).corps;
  assert.ok(controle.avertissements.some((a) => a.includes('SDMPR')));
  ok(await appel('chef', 'POST', `/epidemiologie/donnees/deces/${bon.corps.id}/decision`, { decision: 'valider' }));
  const a = (await appel('chef', 'GET', `/epidemiologie/morbi-mortalite/analyse?dans=${ids.zone}&annee=${AN}`)).corps;
  const prop = a.mortalite.indicateurs.find((i) => i.code === 'PROP-DM');
  assert.equal(prop.numerateur, 1);
  assert.equal(prop.denominateur, 1);
  const rmm = a.mortalite.indicateurs.find((i) => i.code === 'RMM');
  assert.equal(rmm.valeur, null); // aucune naissance vivante dans la période : non calculable
  assert.ok(rmm.raison);
});

test('T10 et T19 : couverture avec numérateur et dénominateur ; consolidation sans double comptage', async () => {
  const chef = (await appel('chef', 'GET', `/epidemiologie/couvertures?entite=${ids.aire}&annee=${AN}`)).corps;
  const cpn1 = chef.indicateurs.find((i) => i.code === 'COUV-CPN1');
  assert.equal(cpn1.numerateur, 2); // CS A + CS B, chaque femme comptée une fois
  assert.equal(cpn1.denominateur, 4000);
  assert.equal(cpn1.valeur, 0.1);
  assert.match(cpn1.formule, /÷/);
  assert.equal(chef.indicateurs.find((i) => i.code === 'COUV-PENTA1').numerateur, 2);
  assert.equal(chef.restreint, false);
  // Hors profil de consolidation : seule la structure de connexion compte.
  const inf = (await appel('infirmiere', 'GET', `/epidemiologie/couvertures?entite=${ids.aire}&annee=${AN}`)).corps;
  assert.equal(inf.indicateurs.find((i) => i.code === 'COUV-CPN1').numerateur, 1);
  assert.equal(inf.restreint, true);
  // Sans population cible validée : non calculable (jamais 0 %).
  const zone = (await appel('chef', 'GET', `/epidemiologie/couvertures?entite=${ids.zone}&annee=${AN}`)).corps;
  assert.equal(zone.indicateurs[0].valeur, null);
  assert.ok(zone.indicateurs[0].raison);
  const structures = (await appel('chef', 'GET', `/epidemiologie/couvertures/structures?entite=${ids.aire}&annee=${AN}`)).corps;
  assert.equal(structures.lignes.length, 2);
});

test('T11-T12 : insuffisance détectée selon la règle validée, affectée, résolue puis clôturée', async () => {
  const regle = await appel('chef', 'POST', '/epidemiologie/alertes/regles', { nom: 'Couverture CPN1 insuffisante', indicateur: 'COUVERTURE', parametre: 'COUV-CPN1', operateur: '<', priorite: 'Élevée', entiteCode: ids.aire });
  ok(regle, 201);
  // Seuil non défini : activation refusée (les seuils ne sont pas inventés).
  assert.equal((await appel('directeur', 'POST', `/epidemiologie/alertes/regles/${regle.corps.code}/activer`, { responsableValidation: 'MCZ', referenceValidation: 'Note' })).status, 400);
  ok(await appel('chef', 'PUT', `/epidemiologie/alertes/regles/${regle.corps.code}`, { seuil: 80 }));
  ok(await appel('directeur', 'POST', `/epidemiologie/alertes/regles/${regle.corps.code}/activer`, { responsableValidation: 'MCZ Zone Essai', referenceValidation: 'PV réunion de validation (essai)' }));
  const d1 = await appel('chef', 'POST', '/epidemiologie/alertes/detection');
  ok(d1);
  const alertes = (await appel('chef', 'GET', '/epidemiologie/alertes?ouvertes=oui')).corps;
  const a = alertes.find((x) => x.declencheur?.regleCode === regle.corps.code && x.entiteCode === ids.aire);
  assert.ok(a, 'alerte de couverture attendue');
  assert.equal(a.declencheur.seuil, 80);
  assert.ok(alertes.some((x) => x.domaine === 'Démographie')); // populations manquantes (structure B…)
  // Pas d'alerte répétitive : la même condition incrémente l'alerte existante.
  ok(await appel('chef', 'POST', '/epidemiologie/alertes/detection'));
  const apres = (await appel('chef', 'GET', `/epidemiologie/alertes/${a.numero}`)).corps;
  assert.equal(apres.occurrences, 2);

  assert.equal((await appel('chef', 'POST', `/epidemiologie/alertes/${a.numero}/cloturer`, {})).status, 400);
  const att = await appel('chef', 'POST', `/epidemiologie/alertes/${a.numero}/attribuer`, { responsableId: ids.titulaire, echeance: AUJ });
  ok(att);
  assert.equal(att.corps.statut, 'Attribuée');
  assert.equal(att.corps.responsable.id, ids.titulaire);
  assert.equal(att.corps.echeance, AUJ);
  ok(await appel('titulaire', 'POST', `/epidemiologie/alertes/${a.numero}/traiter`, { diagnostic: 'Faible fréquentation', actionCorrective: 'Sensibilisation par les RECO' }));
  ok(await appel('titulaire', 'POST', `/epidemiologie/alertes/${a.numero}/resoudre`, { resultat: 'Séances de sensibilisation tenues', preuve: 'Rapport RECO' }));
  const clo = await appel('chef', 'POST', `/epidemiologie/alertes/${a.numero}/cloturer`, { evaluation: 'À suivre le mois prochain' });
  ok(clo);
  assert.equal(clo.corps.statut, 'Clôturée');
  const t = (await appel('chef', 'GET', '/epidemiologie/alertes/tableau')).corps;
  assert.ok(t.tauxResolution.valeur > 0);
});

test('T13, T18 : rapport généré à partir des données validées, exporté, et figé après correction', async () => {
  const r = await appel('chef', 'POST', '/epidemiologie/rapports', { type: 'couvertures', entiteCode: ids.aire, annee: AN });
  ok(r, 201);
  assert.equal(r.corps.statutDonnees, 'Validées uniquement');
  const ligne = r.corps.contenu.sections[0].lignes.find((l) => l[0] === 'COUV-CPN1');
  assert.equal(ligne[2], 2);
  assert.ok(r.corps.versions.calculCouvertures);
  const csv = await appel('chef', 'GET', `/epidemiologie/rapports/${r.corps.numero}/export?format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.texte.toString('utf8'), /COUV-CPN1/);
  assert.match(csv.texte.toString('utf8'), /Définitions des indicateurs/);
  const pdf = await appel('chef', 'GET', `/epidemiologie/rapports/${r.corps.numero}/export?format=pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.texte.subarray(0, 4).toString(), '%PDF');
  const xls = await appel('chef', 'GET', `/epidemiologie/rapports/${r.corps.numero}/export?format=excel`);
  assert.match(xls.texte.toString('utf8'), /<Workbook/);
  // Nouvelle CPN1 : le rapport publié ne change pas ; la régénération crée une nouvelle version.
  const Patiente = require('../models/Patiente');
  const p = await Patiente.create({ numero: 'AC-PAT-980003', nom: 'Essai', prenom: 'Femme3', telephone: '000', etablissementId: ids.csA, adresse: { province: 'Kinshasa' }, creePar: { id: ids.chef, nom: 'Chef', role: 'Médecin chef de service' } });
  await mongoose.connection.collection('consultations').insertOne({ patienteId: p._id, grossesseId: new mongoose.Types.ObjectId(), date: new Date(`${MOIS}-01T11:00:00Z`), statut: 'Finalisée', type: 'Première consultation prénatale' });
  const ancien = (await appel('chef', 'GET', `/epidemiologie/rapports/${r.corps.numero}`)).corps;
  assert.equal(ancien.contenu.sections[0].lignes.find((l) => l[0] === 'COUV-CPN1')[2], 2);
  const nouveau = await appel('chef', 'POST', `/epidemiologie/rapports/${r.corps.numero}/regenerer`);
  ok(nouveau, 201);
  assert.equal(nouveau.corps.version, 2);
  assert.equal(nouveau.corps.contenu.sections[0].lignes.find((l) => l[0] === 'COUV-CPN1')[2], 3);
  assert.equal((await appel('chef', 'GET', `/epidemiologie/rapports/${r.corps.numero}`)).corps.statut, 'Remplacé');
  // Le générateur ne valide pas son propre rapport ; un autre validateur oui.
  ok(await appel('directeur', 'POST', `/epidemiologie/rapports/${nouveau.corps.numero}/valider`, { responsable: 'Dr Directeur', fonction: 'Médecin directeur' }));
});

test('T14 : correction d’une donnée validée — ancienne et nouvelle valeur consultables', async () => {
  const r = await appel('infirmiere', 'PATCH', `/epidemiologie/cas/${ids.cas}`, { issue: 'Guéri' });
  assert.equal(r.status, 400); // motif obligatoire
  const c = await appel('infirmiere', 'PATCH', `/epidemiologie/cas/${ids.cas}`, { issue: 'Guéri', motif: 'Sortie confirmée' });
  ok(c);
  assert.equal(c.corps.statut, 'Soumis'); // la correction repasse en validation
  const h = (await appel('chef', 'GET', `/epidemiologie/donnees/cas/${ids.cas}/historique`)).corps;
  const corr = h.historique.find((x) => x.operation === 'Correction');
  assert.deepEqual(corr.changements.issue, { avant: 'En cours', apres: 'Guéri' });
  assert.equal(corr.motif, 'Sortie confirmée');
  const modifs = (await appel('chef', 'GET', '/epidemiologie/historique/modifications')).corps;
  assert.ok(modifs.some((m) => m.operation === 'Correction' && m.changements.some((x) => x.champ === 'issue')));
  const attente = (await appel('directeur', 'GET', '/epidemiologie/validation/en-attente')).corps;
  assert.ok(attente.some((l) => l.type === 'cas' && l.peutValider));
  const stats = (await appel('chef', 'GET', '/epidemiologie/validation/statistiques')).corps;
  assert.ok(stats.valides > 0 && stats.tauxValidation.valeur > 0);
});

test('T20 : la modification d’un indicateur est versionnée et soumise à validation', async () => {
  const liste = (await appel('chef', 'GET', '/epidemiologie/indicateurs')).corps.indicateurs;
  const cpn4 = liste.find((i) => i.code === 'COUV-CPN4');
  assert.equal(cpn4.parametres.contactsRequis, 4);
  ok(await appel('chef', 'PATCH', `/epidemiologie/indicateurs/${cpn4.id}`, { referenceValidation: 'Fiche technique SMNE (essai)' }));
  await soumettreEtValider('indicateur', cpn4.id);
  const v2 = await appel('chef', 'PATCH', `/epidemiologie/indicateurs/${cpn4.id}`, { contactsRequis: 8, motif: 'Recommandation OMS : 8 contacts' });
  ok(v2);
  assert.equal(v2.corps.version, 2);
  assert.equal(v2.corps.statut, 'Brouillon');
  assert.equal(v2.corps.parametres.contactsRequis, 8);
  // Tant que la v2 n'est pas validée, la v1 (4 contacts) reste appliquée.
  const couv = (await appel('chef', 'GET', `/epidemiologie/couvertures?entite=${ids.aire}&annee=${AN}`)).corps;
  assert.equal(couv.contactsCpnRequis, 4);
  await soumettreEtValider('indicateur', v2.corps.id);
  assert.equal((await appel('chef', 'GET', `/epidemiologie/couvertures?entite=${ids.aire}&annee=${AN}`)).corps.contactsCpnRequis, 8);
});

test('Vue générale : tableau de bord épidémiologique', async () => {
  const r = await appel('infirmiere', 'GET', `/epidemiologie/tableau-de-bord?entite=${ids.aire}&annee=${AN}`);
  ok(r);
  assert.equal(r.corps.population.totale, 100000);
  assert.equal(r.corps.cibles.length, 3);
  assert.equal(r.corps.etapes[0].ok, true);
  assert.equal(r.corps.etapes[2].ok, true);
  compteur += 1;
});

test('Écrans du module : toutes les lectures répondent et les 9 types de rapports se génèrent', async () => {
  const plans = (await appel('chef', 'GET', `/epidemiologie/plans?dans=${ids.aire}&annee=${AN}`)).corps;
  const lectures = [
    '/epidemiologie/referentiel', '/epidemiologie/territoires', `/epidemiologie/tableau-de-bord?entite=${ids.zone}&annee=${AN}`,
    `/epidemiologie/populations?dans=${ids.zone}&annee=${AN}`, `/epidemiologie/populations/synthese?entite=${ids.zone}&annee=${AN}`,
    '/epidemiologie/coefficients', `/epidemiologie/coefficients/applicables?entite=${ids.aire}&annee=${AN}`, '/epidemiologie/indicateurs',
    `/epidemiologie/cibles?dans=${ids.zone}&annee=${AN}`, `/epidemiologie/cibles/synthese?entite=${ids.zone}&annee=${AN}`,
    `/epidemiologie/plans/tableau?entite=${ids.zone}&annee=${AN}&intervention=CPN1&mois=${MOIS}`,
    `/epidemiologie/plans/${plans[0].id}/proposition-geographique`,
    `/epidemiologie/surveillance/tableau?dans=${ids.zone}&mois=${MOIS}`, `/epidemiologie/evenements?dans=${ids.zone}`, `/epidemiologie/cas?dans=${ids.zone}&annee=${AN}`,
    `/epidemiologie/morbi-mortalite/analyse?dans=${ids.zone}&trimestre=${AN}-T1&unite=100000`, `/epidemiologie/morbidite?dans=${ids.zone}`, `/epidemiologie/deces?dans=${ids.zone}`,
    '/epidemiologie/deces/signalements', `/epidemiologie/couvertures?entite=${ids.zone}&mois=${MOIS}`, `/epidemiologie/couvertures/structures?entite=${ids.zone}&annee=${AN}&niveau=enfants`,
    `/epidemiologie/alertes?dans=${ids.zone}`, '/epidemiologie/alertes/tableau', '/epidemiologie/alertes/responsables', '/epidemiologie/alertes/regles',
    '/epidemiologie/rapports', '/epidemiologie/rapports/statistiques',
    '/epidemiologie/validation/en-attente', '/epidemiologie/validation/validees', '/epidemiologie/validation/rejetees', '/epidemiologie/validation/statistiques',
    '/epidemiologie/historique/modifications', '/epidemiologie/historique/journal', '/epidemiologie/historique/calculs-rapports',
  ];
  for (const chemin of lectures) {
    for (const qui of ['chef', 'infirmiere']) {
      const r = await appel(qui, 'GET', chemin);
      assert.equal(r.status, 200, `${qui} ${chemin} : ${JSON.stringify(r.corps)}`);
    }
  }
  for (const type of ['demographique', 'cibles', 'planification', 'surveillance', 'morbidite', 'mortalite', 'couvertures', 'alertes', 'synthese']) {
    const r = await appel('chef', 'POST', '/epidemiologie/rapports', { type, entiteCode: ids.zone, annee: AN });
    assert.equal(r.status, 201, `${type} : ${JSON.stringify(r.corps)}`);
    assert.ok(r.corps.contenu.sections.length > 0, type);
    for (const format of ['pdf', 'excel', 'csv']) {
      assert.equal((await appel('chef', 'GET', `/epidemiologie/rapports/${r.corps.numero}/export?format=${format}`)).status, 200, `${type} ${format}`);
    }
  }
});
