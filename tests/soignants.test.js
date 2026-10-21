// Modification du profil d'un soignant par le médecin chef (base en mémoire, données fictives).
// Lancer : npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');

let serveurMongo;
let api;
let http;
let mongoose;
const jetons = {};
const comptes = {};
const etablissements = {};

async function appel(qui, methode, chemin, corps) {
  const r = await fetch(`${api}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jetons[qui]}` },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  return { status: r.status, corps: await r.json() };
}

/** Envoi multipart, comme le tableau de bord (affectations en chaîne JSON). */
async function appelFormulaire(qui, chemin, champs) {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.append(k, v);
  const r = await fetch(`${api}${chemin}`, { method: 'PATCH', headers: { Authorization: `Bearer ${jetons[qui]}` }, body: f });
  return { status: r.status, corps: await r.json() };
}

before(async () => {
  serveurMongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = serveurMongo.getUri('ami_connecte_essai');
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  const app = require('../app');
  mongoose = require('mongoose');
  await mongoose.connection.asPromise();
  assert.equal(mongoose.connection.name, 'ami_connecte_essai');

  const Soignant = require('../models/Soignant');
  const Etablissement = require('../models/Etablissement');
  const jwt = require('jsonwebtoken');
  const baseEt = { type: 'Centre de santé', secteur: 'Public', province: 'Kinshasa', zoneSante: 'ZS Fictive', adresse: 'Fictive', telephone: '000', responsable: 'Fictif', services: ['CPN'] };
  etablissements.a = await Etablissement.create({ ...baseEt, code: 'ETS-T-1', nom: 'Centre A' });
  etablissements.b = await Etablissement.create({ ...baseEt, code: 'ETS-T-2', nom: 'Centre B' });
  etablissements.suspendu = await Etablissement.create({ ...baseEt, code: 'ETS-T-3', nom: 'Centre suspendu', statut: 'Suspendu' });

  const base = {
    postnom: 'TEST', sexe: 'M', dateNaissance: '1985-01-01', lieuNaissance: 'Kinshasa', nationalite: 'Congolaise',
    pieceType: 'Passeport', adresse: 'Fictive', telephone: '000', grade: 'Médecin généraliste',
    specialite: 'Médecine générale', affectations: [{ etablissementId: etablissements.a.id }], motDePasse: 'x',
  };
  for (const [cle, d] of Object.entries({
    chef: { prenom: 'Alain', nom: 'CHEF', role: 'Médecin chef de service', matricule: 'MED-9101' },
    medecin: { prenom: 'Aimée', nom: 'AMANI', role: 'Médecin', matricule: 'MED-9102' },
    infirmiere: { prenom: 'Inès', nom: 'ILUNGA', role: 'Infirmier(ère)', matricule: 'INF-9101', grade: 'Diplômé(e) (A2)', specialite: 'Soins infirmiers généraux' },
  })) {
    comptes[cle] = await Soignant.create({ ...base, ...d, email: `${cle}@essai.test` });
    jetons[cle] = jwt.sign({ sub: comptes[cle].id, role: d.role }, process.env.JWT_SECRET, { expiresIn: '10m' });
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

test('le médecin chef modifie le profil et affecte des établissements actifs', async () => {
  const r = await appelFormulaire('chef', `/soignants/${comptes.infirmiere.id}`, {
    telephone: '+243 81 111 2222', grade: 'Gradué(e) (A1)', role: 'Infirmier(ère) titulaire',
    affectations: JSON.stringify([{ etablissementId: etablissements.b.id, service: 'Maternité' }, { etablissementId: etablissements.a.id, service: '' }]),
  });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.equal(r.corps.telephone, '+243 81 111 2222');
  assert.equal(r.corps.role, 'Infirmier(ère) titulaire');
  assert.deepEqual(r.corps.affectations.map((a) => a.etablissementId), [etablissements.b.id, etablissements.a.id], 'le premier reste le principal');
  assert.equal(r.corps.affectations[0].service, 'Maternité');
  assert.ok(!('motDePasse' in r.corps));
});

test('affectation refusée vers un établissement suspendu, inexistant ou en double', async () => {
  for (const affectations of [
    [{ etablissementId: etablissements.suspendu.id }],
    [{ etablissementId: '64b000000000000000000000' }],
    [{ etablissementId: etablissements.a.id }, { etablissementId: etablissements.a.id }],
    [],
  ]) {
    const r = await appel('chef', 'PATCH', `/soignants/${comptes.medecin.id}`, { affectations });
    assert.equal(r.status, 400, JSON.stringify(affectations));
  }
});

test('seul le médecin chef peut modifier le profil d’un autre soignant', async () => {
  assert.equal((await appel('medecin', 'PATCH', `/soignants/${comptes.infirmiere.id}`, { telephone: '1' })).status, 403);
  assert.equal((await appel('infirmiere', 'PATCH', `/soignants/${comptes.medecin.id}`, { telephone: '1' })).status, 403);
});

test('le médecin chef ne peut pas changer son propre rôle ; e-mail déjà pris refusé', async () => {
  assert.equal((await appel('chef', 'PATCH', `/soignants/${comptes.chef.id}`, { role: 'Médecin' })).status, 400);
  assert.equal((await appel('chef', 'PATCH', `/soignants/${comptes.medecin.id}`, { email: 'infirmiere@essai.test' })).status, 409);
  const ok = await appel('chef', 'PATCH', `/soignants/${comptes.medecin.id}`, { email: 'Nouvelle.Adresse@Essai.test' });
  assert.equal(ok.corps.email, 'nouvelle.adresse@essai.test');
});
