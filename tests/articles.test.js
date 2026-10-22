// Tests d'API des articles de conseils (médecins seulement, médias, j'aime, commentaires, suppressions).
// Base MongoDB en mémoire et stockage R2 simulé : aucune donnée réelle n'est lue ni écrite.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');

let serveurMongo;
let api;
let http;
let mongoose;
const jetons = {};
const comptes = {};
const r2 = { envoyes: [], supprimes: [] };

async function appel(qui, methode, chemin, corps) {
  const r = await fetch(`${api}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jetons[qui]}` },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  return { status: r.status, corps: texte ? JSON.parse(texte) : null };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Publication multipart, comme le formulaire du tableau de bord. */
async function publier(qui, champs, medias = []) {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.append(k, v);
  for (const m of medias) f.append('medias', new Blob([m.contenu ?? PNG], { type: m.type }), m.nom);
  const r = await fetch(`${api}/articles`, { method: 'POST', headers: { Authorization: `Bearer ${jetons[qui]}` }, body: f });
  const texte = await r.text();
  return { status: r.status, corps: texte ? JSON.parse(texte) : null };
}

const photo = (n) => ({ type: 'image/png', nom: `photo${n}.png` });
const video = { type: 'video/mp4', nom: 'conseil.mp4', contenu: Buffer.from('fausse-video') };

before(async () => {
  serveurMongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = serveurMongo.getUri('ami_connecte_essai_articles');
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  const stockage = require('../config/r2');
  stockage.envoyerFichier = async (fichier, dossier) => {
    const cle = `${dossier}/essai-${r2.envoyes.length}`;
    r2.envoyes.push({ cle, type: fichier.mimetype });
    return { cle, url: `https://public.invalid/${cle}` };
  };
  stockage.supprimerFichier = async (cle) => { r2.supprimes.push(cle); };
  const app = require('../app');
  mongoose = require('mongoose');
  await mongoose.connection.asPromise();
  assert.equal(mongoose.connection.name, 'ami_connecte_essai_articles');

  const Soignant = require('../models/Soignant');
  const jwt = require('jsonwebtoken');
  const base = {
    postnom: 'TEST', sexe: 'M', dateNaissance: '1985-01-01', lieuNaissance: 'Kinshasa', nationalite: 'Congolaise',
    pieceType: 'Passeport', adresse: 'Fictive', telephone: '000', grade: 'Médecin généraliste',
    specialite: 'Médecine générale', affectations: [{ etablissementId: 'ET-TEST' }], motDePasse: 'x',
  };
  const definitions = {
    chef: { prenom: 'Alain', nom: 'CHEF', role: 'Médecin chef de service', matricule: 'MED-8001' },
    medecinA: { prenom: 'Aimée', nom: 'AMANI', role: 'Médecin', matricule: 'MED-8002' },
    medecinB: { prenom: 'Bruno', nom: 'BOKANGA', role: 'Médecin', matricule: 'MED-8003' },
    infirmiere: { prenom: 'Inès', nom: 'ILUNGA', role: 'Infirmier(ère)', matricule: 'INF-8001' },
  };
  for (const [cle, d] of Object.entries(definitions)) {
    comptes[cle] = await Soignant.create({ ...base, ...d, email: `${cle}@articles.test` });
    jetons[cle] = jwt.sign({ sub: comptes[cle].id, role: d.role, etablissement: null }, process.env.JWT_SECRET, { expiresIn: '10m' });
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

let article;

test('infirmière : ni publication ni lecture des articles', async () => {
  const p = await publier('infirmiere', { titre: 'Essai', contenu: 'Texte' });
  assert.equal(p.status, 403);
  assert.equal((await appel('infirmiere', 'GET', '/articles')).status, 403);
});

test('médecin : publication avec 4 photos ; 5 photos ou photos + vidéo refusées ; une vidéo seule acceptée', async () => {
  const p = await publier('medecinA', { titre: 'Bien manger pendant la grossesse', contenu: 'Fer, acide folique…', cible: 'Grossesse (CPN)' }, [1, 2, 3, 4].map(photo));
  assert.equal(p.status, 201, JSON.stringify(p.corps));
  assert.equal(p.corps.medias.length, 4);
  assert.ok(p.corps.medias.every((m) => m.type === 'image'));
  assert.equal(p.corps.auteur.id, comptes.medecinA.id);
  assert.equal(p.corps.cible, 'Grossesse (CPN)');
  article = p.corps;

  assert.equal((await publier('medecinA', { titre: 'T', contenu: 'C' }, [1, 2, 3, 4, 5].map(photo))).status, 400);
  assert.equal((await publier('medecinA', { titre: 'T', contenu: 'C' }, [photo(1), video])).status, 400);
  assert.equal((await publier('medecinA', { titre: '', contenu: 'C' })).status, 400);

  const v = await publier('medecinB', { titre: 'Allaitement', contenu: 'Les premiers jours', cible: 'Après l’accouchement' }, [video]);
  assert.equal(v.status, 201, JSON.stringify(v.corps));
  assert.equal(v.corps.medias[0].type, 'video');
  articleVideo = v.corps;
});

let articleVideo;
let articleChef;

test('approbation : article en attente visible de son auteur et du chef seulement ; seul le chef approuve ou rejette', async () => {
  assert.equal(article.statut, 'En attente');
  assert.equal(article.peutSupprimer, false, 'l’auteur ne supprime pas son article');
  assert.equal(article.peutApprouver, false);

  // Les autres médecins ne voient pas un article en attente.
  const b = await appel('medecinB', 'GET', '/articles');
  assert.deepEqual(b.corps.articles.map((a) => a.id), [articleVideo.id], 'le médecin B ne voit que son propre article en attente');
  assert.equal(b.corps.enAttente, null, 'compteur réservé au chef');
  assert.equal((await appel('medecinB', 'GET', `/articles/${article.id}`)).status, 404);

  // Ni j'aime ni commentaire avant approbation ; ni approbation ni suppression par un médecin.
  assert.equal((await appel('medecinA', 'POST', `/articles/${article.id}/jaime`)).status, 409);
  assert.equal((await appel('medecinA', 'POST', `/articles/${article.id}/commentaires`, { texte: 'Essai' })).status, 409);
  assert.equal((await appel('medecinA', 'POST', `/articles/${article.id}/approuver`)).status, 403);
  assert.equal((await appel('medecinA', 'DELETE', `/articles/${article.id}`)).status, 403, 'l’auteur ne supprime pas');

  // File d'approbation du médecin chef.
  const f = await appel('chef', 'GET', '/articles?statut=En attente');
  assert.equal(f.corps.total, 2);
  assert.equal(f.corps.enAttente, 2);
  assert.ok(f.corps.articles.every((a) => a.peutApprouver && a.peutSupprimer));

  const ok = await appel('chef', 'POST', `/articles/${article.id}/approuver`);
  assert.equal(ok.status, 200);
  assert.equal(ok.corps.statut, 'Approuvé');
  assert.equal(ok.corps.approbation.par.id, comptes.chef.id);
  assert.equal((await appel('chef', 'POST', `/articles/${article.id}/approuver`)).status, 409, 'déjà approuvé');

  // Rejet : l'article et sa vidéo sont supprimés du bucket.
  assert.equal((await appel('chef', 'DELETE', `/articles/${articleVideo.id}`)).status, 204);
  assert.ok(r2.supprimes.includes(articleVideo.medias[0].cle), 'vidéo retirée de R2');
  assert.equal((await appel('medecinB', 'GET', `/articles/${articleVideo.id}`)).status, 404);

  // Le médecin chef publie directement.
  const c = await publier('chef', { titre: 'Vaccins de la mère', contenu: 'VAT pendant la grossesse' });
  assert.equal(c.corps.statut, 'Approuvé');
  articleChef = c.corps;

  const JournalAudit = require('../models/JournalAudit');
  assert.equal(await JournalAudit.countDocuments({ action: 'article.approbation' }), 1);
});

test('tous les médecins voient les publications ; j’aime en bascule, un par médecin', async () => {
  const l = await appel('medecinB', 'GET', '/articles');
  assert.equal(l.status, 200);
  assert.equal(l.corps.total, 2);
  const vu = l.corps.articles.find((a) => a.id === article.id);
  assert.equal(vu.peutSupprimer, false, 'le médecin B ne peut pas supprimer l’article du médecin A');
  assert.ok(!('jaimes' in vu), 'liste des personnes non exposée');

  let j = await appel('medecinB', 'POST', `/articles/${article.id}/jaime`);
  assert.equal(j.corps.nbJaimes, 1);
  assert.equal(j.corps.jAime, true);
  j = await appel('chef', 'POST', `/articles/${article.id}/jaime`);
  assert.equal(j.corps.nbJaimes, 2);
  j = await appel('medecinB', 'POST', `/articles/${article.id}/jaime`);
  assert.equal(j.corps.nbJaimes, 1);
  assert.equal(j.corps.jAime, false);
});

test('commentaires : seul l’auteur de l’article répond ; chacun ne supprime que ce qu’il a écrit', async () => {
  let c = await appel('medecinB', 'POST', `/articles/${article.id}/commentaires`, { texte: 'Et pour les femmes anémiées ?' });
  assert.equal(c.status, 201);
  const commentaire = c.corps.commentaires[0];
  assert.equal(commentaire.auteur.id, comptes.medecinB.id);

  assert.equal((await appel('medecinB', 'POST', `/articles/${article.id}/commentaires/${commentaire.id}/reponses`, { texte: 'Moi aussi' })).status, 403);
  const r = await appel('medecinA', 'POST', `/articles/${article.id}/commentaires/${commentaire.id}/reponses`, { texte: 'Supplémentation en fer selon l’Hb.' });
  assert.equal(r.status, 201);
  const reponse = r.corps.commentaires[0].reponses[0];
  assert.equal(reponse.auteur.id, comptes.medecinA.id);

  // L'auteur de l'article ne supprime pas le commentaire d'un autre ; l'auteur du commentaire, si.
  assert.equal((await appel('medecinA', 'DELETE', `/articles/${article.id}/commentaires/${commentaire.id}`)).status, 403);
  assert.equal((await appel('medecinB', 'DELETE', `/articles/${article.id}/commentaires/${commentaire.id}/reponses/${reponse.id}`)).status, 403);
  c = await appel('medecinB', 'DELETE', `/articles/${article.id}/commentaires/${commentaire.id}`);
  assert.equal(c.status, 200);
  assert.equal(c.corps.commentaires.length, 0);
});

test('suppression d’article : médecin chef seulement (même pour l’auteur) ; médias retirés de R2', async () => {
  assert.equal((await appel('medecinB', 'DELETE', `/articles/${article.id}`)).status, 403);
  assert.equal((await appel('medecinA', 'DELETE', `/articles/${article.id}`)).status, 403, 'l’auteur ne supprime pas');
  const c = await appel('medecinB', 'POST', `/articles/${article.id}/commentaires`, { texte: 'Merci' });
  const cid = c.corps.commentaires[0].id;
  assert.equal((await appel('chef', 'DELETE', `/articles/${article.id}/commentaires/${cid}`)).status, 200, 'le chef supprime tout');

  assert.equal((await appel('chef', 'DELETE', `/articles/${article.id}`)).status, 204);
  assert.deepEqual(r2.supprimes.filter((k) => article.medias.some((m) => m.cle === k)).length, 4);
  assert.equal((await appel('medecinA', 'GET', `/articles/${article.id}`)).status, 404);

  const l = await appel('medecinB', 'GET', '/articles');
  assert.deepEqual(l.corps.articles.map((a) => a.id), [articleChef.id]);
  assert.equal(l.corps.articles[0].peutSupprimer, false);
  assert.equal((await appel('chef', 'DELETE', `/articles/${articleChef.id}`)).status, 204, 'le chef supprime son propre article');

  const JournalAudit = require('../models/JournalAudit');
  assert.equal(await JournalAudit.countDocuments({ action: 'article.suppression' }), 3);
});
