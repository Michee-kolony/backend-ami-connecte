// Discussions entre soignants : temps réel (socket.io), participants seulement, chiffrement au repos.
// Base en mémoire et comptes fictifs. Lancer : npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { io: client } = require('socket.io-client');

let serveurMongo;
let serveur;
let base;
let mongoose;
const jetons = {};
const comptes = {};
const sockets = [];

async function appel(qui, methode, chemin, corps) {
  const r = await fetch(`${base}/api${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jetons[qui]}` },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  return { status: r.status, corps: texte ? JSON.parse(texte) : null };
}

/** Connexion temps réel d'un soignant ; renvoie le socket et une file d'événements reçus. */
async function connecter(qui) {
  const s = client(base, { auth: { jeton: jetons[qui] }, transports: ['websocket'], reconnection: false });
  sockets.push(s);
  const recus = [];
  s.onAny((evenement, donnees) => recus.push({ evenement, donnees }));
  await new Promise((ok, ko) => { s.once('presence', ok); s.once('connect_error', ko); });
  return { s, recus };
}

/** Attend qu'un événement arrive (ou échoue après `ms`). */
function attendre(recus, evenement, ms = 2000) {
  return new Promise((ok, ko) => {
    const debut = Date.now();
    const t = setInterval(() => {
      const e = recus.find((x) => x.evenement === evenement);
      if (e) { clearInterval(t); ok(e.donnees); } else if (Date.now() - debut > ms) { clearInterval(t); ko(new Error(`${evenement} non reçu`)); }
    }, 20);
  });
}

before(async () => {
  serveurMongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = serveurMongo.getUri('ami_connecte_essai');
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  process.env.CHAT_CLE = Buffer.alloc(32, 7).toString('base64');
  const app = require('../app');
  mongoose = require('mongoose');
  await mongoose.connection.asPromise();
  assert.equal(mongoose.connection.name, 'ami_connecte_essai');

  const { Server } = require('socket.io');
  serveur = http.createServer(app);
  require('../config/presence').initialiser(new Server(serveur));
  await new Promise((r) => serveur.listen(0, r));
  base = `http://127.0.0.1:${serveur.address().port}`;

  const Soignant = require('../models/Soignant');
  const jwt = require('jsonwebtoken');
  const commun = {
    postnom: 'TEST', sexe: 'F', dateNaissance: '1988-01-01', lieuNaissance: 'Kinshasa', nationalite: 'Congolaise',
    pieceType: 'Passeport', adresse: 'Fictive', telephone: '000', grade: 'Médecin généraliste',
    specialite: 'Médecine générale', affectations: [{ etablissementId: 'ET-TEST' }], motDePasse: 'x',
  };
  for (const [cle, d] of Object.entries({
    medecin: { prenom: 'Marie', nom: 'MEDECIN', role: 'Médecin', matricule: 'MED-9201' },
    infirmiere: { prenom: 'Ines', nom: 'INFIRMIERE', role: 'Infirmier(ère)', matricule: 'INF-9201' },
    intrus: { prenom: 'Igor', nom: 'INTRUS', role: 'Médecin', matricule: 'MED-9202' },
    suspendu: { prenom: 'Sam', nom: 'SUSPENDU', role: 'Médecin', matricule: 'MED-9203', statut: 'Suspendu' },
    ailleurs: { prenom: 'Alex', nom: 'AILLEURS', role: 'Médecin', matricule: 'MED-9204', affectations: [{ etablissementId: 'ET-AUTRE' }] },
  })) {
    comptes[cle] = await Soignant.create({ ...commun, ...d, email: `${cle}@essai.test` });
    jetons[cle] = jwt.sign({ sub: comptes[cle].id, role: d.role, etablissement: 'ET-TEST' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  }
});

after(async () => {
  sockets.forEach((s) => s.close());
  serveur?.close();
  await mongoose?.disconnect();
  await serveurMongo?.stop();
});

let discussionId;

test('médecin et infirmière : message remis en temps réel aux deux, chiffré en base', async () => {
  const med = await connecter('medecin');
  const inf = await connecter('infirmiere');

  const o = await appel('medecin', 'POST', '/discussions', { soignantId: comptes.infirmiere.id });
  assert.equal(o.status, 201);
  discussionId = o.corps.id;
  assert.equal(o.corps.interlocuteur.nom, 'INFIRMIERE');
  const encore = await appel('infirmiere', 'POST', '/discussions', { soignantId: comptes.medecin.id });
  assert.equal(encore.corps.id, discussionId, 'une seule discussion par paire');

  const texte = 'Bonjour, la patiente AC-PAT-000001 peut-elle être revue demain à 9 h ?';
  const envoi = await appel('medecin', 'POST', `/discussions/${discussionId}/messages`, { texte });
  assert.equal(envoi.status, 201);
  const recu = await attendre(inf.recus, 'discussion:message');
  assert.equal(recu.texte, texte);
  assert.equal(recu.auteurId, comptes.medecin.id);
  assert.equal((await attendre(med.recus, 'discussion:message')).id, recu.id, 'aussi sur les autres onglets de l’auteur');

  // Au repos, le texte n'est jamais en clair.
  const brut = await mongoose.connection.db.collection('messages_discussions').findOne({});
  assert.ok(!JSON.stringify(brut).includes('patiente'), 'contenu chiffré en base');
  assert.ok(brut.contenu.iv && brut.contenu.tag && brut.contenu.d);

  const liste = await appel('infirmiere', 'GET', '/discussions');
  assert.equal(liste.corps[0].nonLus, 1);
  assert.equal(liste.corps[0].dernierMessage.texte, texte);

  const lu = await appel('infirmiere', 'POST', `/discussions/${discussionId}/lu`);
  assert.equal(lu.corps.lus, 1);
  const accuse = await attendre(med.recus, 'discussion:lu');
  assert.equal(accuse.soignantId, comptes.infirmiere.id);
  assert.equal((await appel('infirmiere', 'GET', '/discussions')).corps[0].nonLus, 0);

  inf.s.emit('discussion:ecrit', { discussionId });
  assert.equal((await attendre(med.recus, 'discussion:ecrit')).soignantId, comptes.infirmiere.id, 'indicateur de saisie');
});

test('un soignant étranger à la discussion ne peut ni lire, ni écrire, ni rien recevoir', async () => {
  const intrus = await connecter('intrus');
  assert.equal((await appel('intrus', 'GET', `/discussions/${discussionId}/messages`)).status, 404);
  assert.equal((await appel('intrus', 'POST', `/discussions/${discussionId}/messages`, { texte: 'Je m’invite' })).status, 404);
  assert.equal((await appel('intrus', 'POST', `/discussions/${discussionId}/lu`)).status, 404);
  assert.equal((await appel('intrus', 'GET', '/discussions')).corps.length, 0);
  intrus.s.emit('discussion:ecrit', { discussionId });
  await appel('medecin', 'POST', `/discussions/${discussionId}/messages`, { texte: 'Message privé' });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!intrus.recus.some((e) => e.evenement.startsWith('discussion:')), 'aucun événement reçu par un tiers');
});

test('contrôles : message vide ou trop long, soi-même, compte suspendu, débit limité', async () => {
  assert.equal((await appel('medecin', 'POST', `/discussions/${discussionId}/messages`, { texte: '   ' })).status, 400);
  assert.equal((await appel('medecin', 'POST', `/discussions/${discussionId}/messages`, { texte: 'x'.repeat(2001) })).status, 400);
  assert.equal((await appel('medecin', 'POST', '/discussions', { soignantId: comptes.medecin.id })).status, 400);
  assert.equal((await appel('medecin', 'POST', '/discussions', { soignantId: comptes.suspendu.id })).status, 404);
  assert.equal((await appel('suspendu', 'GET', '/discussions')).status, 401);
  await assert.rejects(connecter('suspendu'), 'connexion temps réel refusée');
  const annuaire = await appel('infirmiere', 'GET', '/discussions/annuaire');
  assert.ok(!annuaire.corps.some((s) => s.id === comptes.suspendu.id || s.id === comptes.infirmiere.id));
  assert.ok(!JSON.stringify(annuaire.corps).includes('email'));

  let refuse = null;
  for (let i = 0; i < 35 && !refuse; i++) {
    const r = await appel('infirmiere', 'POST', `/discussions/${discussionId}/messages`, { texte: `Message ${i}` });
    if (r.status === 429) refuse = i;
  }
  assert.ok(refuse !== null && refuse <= 30, 'au-delà de 30 messages par minute : 429');
});

test('historique paginé, du plus ancien au plus récent', async () => {
  // Historique ancien inséré directement (le débit limite les envois par l'API).
  const MessageDiscussion = require('../models/MessageDiscussion');
  const { chiffrer } = require('../config/chiffrement');
  const debut = Date.now() - 3600000;
  await MessageDiscussion.insertMany(Array.from({ length: 40 }, (_, i) => ({
    discussionId, auteurId: comptes.medecin.id, contenu: chiffrer(`Ancien ${i}`),
    createdAt: new Date(debut + i * 1000), updatedAt: new Date(debut + i * 1000),
  })));
  const p1 = await appel('medecin', 'GET', `/discussions/${discussionId}/messages`);
  assert.equal(p1.status, 200);
  assert.equal(p1.corps.messages.length, 50);
  assert.equal(p1.corps.plusAnciens, true);
  const dates = p1.corps.messages.map((m) => m.envoyeLe);
  assert.deepEqual(dates, [...dates].sort());
  const p2 = await appel('medecin', 'GET', `/discussions/${discussionId}/messages?avant=${encodeURIComponent(p1.corps.messages[0].envoyeLe)}`);
  assert.ok(p2.corps.messages.length > 0);
  assert.ok(p2.corps.messages.at(-1).envoyeLe < p1.corps.messages[0].envoyeLe);
});

test('patiente ↔ soignant : choix du soignant, messages en temps réel, présence vue des deux côtés', async () => {
  const Patiente = require('../models/Patiente');
  const jwt = require('jsonwebtoken');
  const auteur = { id: comptes.medecin.id, nom: 'Marie MEDECIN', role: 'Médecin' };
  const patiente = await Patiente.create({ numero: 'AC-PAT-990001', nom: 'Kabila', prenom: 'Esther', espaceEnLigne: 'Activé', etablissementId: 'ET-TEST', creePar: auteur });
  const inactive = await Patiente.create({ numero: 'AC-PAT-990002', nom: 'Sans', prenom: 'Espace', etablissementId: 'ET-TEST', creePar: auteur });
  jetons.patiente = jwt.sign({ sub: patiente.id, typ: 'patiente' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  jetons.inactive = jwt.sign({ sub: inactive.id, typ: 'patiente' }, process.env.JWT_SECRET, { expiresIn: '10m' });

  // Présence : le médecin voit la patiente arriver ; la patiente voit les soignants en ligne.
  const med = await connecter('medecin');
  const s = client(base, { auth: { jeton: jetons.patiente }, transports: ['websocket'], reconnection: false });
  sockets.push(s);
  const recusP = [];
  s.onAny((evenement, donnees) => recusP.push({ evenement, donnees }));
  const soignantsEnLigne = await attendre(recusP, 'presence:soignants');
  assert.ok(soignantsEnLigne.includes(comptes.medecin.id));
  assert.ok(!recusP.some((e) => e.evenement === 'presence'), 'pas la liste détaillée du personnel');
  await new Promise((r) => setTimeout(r, 200));
  const vues = med.recus.filter((e) => e.evenement === 'presence:patientes').at(-1).donnees;
  assert.ok(vues.includes(patiente.id), 'patiente en ligne pour le personnel');
  await assert.rejects(new Promise((ok, ko) => {
    const x = client(base, { auth: { jeton: jetons.inactive }, transports: ['websocket'], reconnection: false });
    sockets.push(x);
    x.once('connect', ok);
    x.once('connect_error', ko);
  }), 'espace non activé refusé');

  // Annuaire et ouverture : soignants actifs de son établissement (ni suspendus, ni d'ailleurs, sans matricule).
  const annuaire = await appel('patiente', 'GET', '/espace-patiente/soignants');
  assert.equal(annuaire.status, 200);
  assert.ok(annuaire.corps.some((x) => x.id === comptes.infirmiere.id));
  assert.ok(!annuaire.corps.some((x) => x.id === comptes.suspendu.id));
  assert.ok(!('matricule' in annuaire.corps[0]));
  assert.equal((await appel('patiente', 'POST', '/espace-patiente/discussions', { soignantId: comptes.suspendu.id })).status, 404);
  assert.ok(!annuaire.corps.some((x) => x.id === comptes.ailleurs.id), 'soignant d’un autre établissement absent');
  assert.equal((await appel('patiente', 'POST', '/espace-patiente/discussions', { soignantId: comptes.ailleurs.id })).status, 404);
  const o = await appel('patiente', 'POST', '/espace-patiente/discussions', { soignantId: comptes.medecin.id });
  assert.equal(o.status, 201, JSON.stringify(o.corps));
  const id = o.corps.id;

  // La patiente écrit : le médecin reçoit en temps réel et voit une patiente dans sa liste.
  const envoi = await appel('patiente', 'POST', `/espace-patiente/discussions/${id}/messages`, { texte: 'Bonjour docteur, j’ai des maux de tête.' });
  assert.equal(envoi.status, 201, JSON.stringify(envoi.corps));
  assert.equal((await attendre(med.recus, 'discussion:message')).auteurId, patiente.id);
  const listeMed = (await appel('medecin', 'GET', '/discussions')).corps.find((d) => d.id === id);
  assert.equal(listeMed.interlocuteur.role, 'Patiente');
  assert.equal(listeMed.interlocuteur.matricule, 'AC-PAT-990001');
  assert.equal(listeMed.nonLus, 1);

  // Le médecin répond depuis l'espace administrateur ; la patiente reçoit, lit, accusé côté médecin.
  med.recus.length = 0;
  recusP.length = 0;
  await appel('medecin', 'POST', `/discussions/${id}/messages`, { texte: 'Prenez votre tension et venez demain.' });
  assert.equal((await attendre(recusP, 'discussion:message')).auteurId, comptes.medecin.id);
  assert.equal((await appel('patiente', 'GET', '/espace-patiente/discussions')).corps[0].nonLus, 1);
  assert.equal((await appel('patiente', 'POST', `/espace-patiente/discussions/${id}/lu`)).corps.lus, 1);
  assert.equal((await attendre(med.recus, 'discussion:lu')).soignantId, patiente.id);
  s.emit('discussion:ecrit', { discussionId: id });
  assert.equal((await attendre(med.recus, 'discussion:ecrit')).soignantId, patiente.id);

  // Cloisonnement : un autre soignant ne lit pas, la patiente ne lit pas les discussions du personnel.
  assert.equal((await appel('intrus', 'GET', `/discussions/${id}/messages`)).status, 404);
  assert.equal((await appel('patiente', 'GET', `/espace-patiente/discussions/${discussionId}/messages`)).status, 404);
  assert.equal((await appel('patiente', 'GET', '/discussions')).status, 403, 'routes du personnel refusées');

  // Côté soignant : recherche des patientes joignables, ouverture par numéro (même discussion).
  const trouvees = await appel('infirmiere', 'GET', '/discussions/patientes?q=kabila');
  assert.deepEqual(trouvees.corps.map((x) => x.matricule), ['AC-PAT-990001'], 'espace non activé exclu');
  const parNumero = await appel('medecin', 'POST', '/discussions', { patienteId: 'AC-PAT-990001' });
  assert.equal(parNumero.status, 201, JSON.stringify(parNumero.corps));
  assert.equal(parNumero.corps.id, id, 'une seule discussion par paire');
  assert.equal((await appel('medecin', 'POST', '/discussions', { patienteId: 'AC-PAT-990002' })).status, 409, 'application non activée');
  assert.equal((await appel('medecin', 'POST', '/discussions', { patienteId: 'AC-PAT-000000' })).status, 404);
  // Cloisonnement : une patiente d'un autre établissement n'est ni trouvée ni joignable.
  await Patiente.create({ numero: 'AC-PAT-990003', nom: 'Kabila', prenom: 'Ailleurs', espaceEnLigne: 'Activé', etablissementId: 'ET-AUTRE', creePar: auteur });
  assert.ok(!(await appel('infirmiere', 'GET', '/discussions/patientes?q=kabila')).corps.some((x) => x.matricule === 'AC-PAT-990003'));
  assert.equal((await appel('medecin', 'POST', '/discussions', { patienteId: 'AC-PAT-990003' })).status, 404);
  const premier = await appel('infirmiere', 'POST', '/discussions', { patienteId: patiente.id });
  assert.equal(premier.status, 201);
  await appel('infirmiere', 'POST', `/discussions/${premier.corps.id}/messages`, { texte: 'Bonjour Esther, ici l’infirmière Inès.' });
  assert.ok((await appel('patiente', 'GET', '/espace-patiente/discussions')).corps.some((d) => d.interlocuteur.id === comptes.infirmiere.id),
    'la patiente voit la discussion ouverte par le soignant');

  // Déconnexion : la patiente disparaît de la liste des patientes en ligne.
  med.recus.length = 0;
  s.close();
  const apres = await attendre(med.recus, 'presence:patientes');
  assert.ok(!apres.includes(patiente.id));
});
