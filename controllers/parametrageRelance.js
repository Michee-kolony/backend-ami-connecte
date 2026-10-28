// Paramétrage de la relance (sections 7 et 16) : fiches des parcours RAC, ARC, RPC, IRC, TCC et
// règles de déclenchement. Chaque modification crée une nouvelle version (l'ancienne est gardée
// dans l'historique) et repasse « à valider » / « inactive » : rien ne s'applique sans validation
// explicite d'un responsable, avec la référence du document ou du protocole validé.
const ParcoursRelance = require('../models/ParcoursRelance');
const RegleRelance = require('../models/RegleRelance');
const { auteurDe } = require('../models/commun');
const { journaliser } = require('../config/audit');
const moteur = require('../config/moteurRelance');
const r = require('../config/relance');
const { erreur, texte, objet, jour, valider } = require('./saisie');

async function exigerParametrage(req) {
  if (r.ROLES_PARAMETRAGE.includes(req.soignant.role)) return;
  await journaliser(req, { action: 'acces.refuse', resultat: 'refusé', ressource: { type: 'relance', id: 'parametrage' }, details: { role: req.soignant.role } });
  throw erreur(403, 'Le paramétrage de la relance est réservé aux responsables (médecin chef de service, médecin directeur).');
}

/** Archive la version en cours puis prépare la suivante. */
function nouvelleVersion(doc, Modele, par) {
  const instantane = Object.fromEntries(Modele.CHAMPS_CONTENU.map((k) => {
    const v = doc.get(k);
    return [k, v?.toObject ? v.toObject() : v];
  }));
  doc.historique.push(instantane);
  doc.version += 1;
  doc.modifiePar = par;
  doc.modifieLe = new Date();
}

async function trouver(Modele, code, libelle) {
  const doc = await Modele.findOne({ code: String(code) });
  if (!doc) throw erreur(404, `${libelle} introuvable.`);
  return doc;
}

exports.lire = async (req, res) => {
  await moteur.initialiserParametrage();
  const [parcours, regles] = await Promise.all([ParcoursRelance.find().sort({ code: 1 }), RegleRelance.find().sort({ domaine: 1, code: 1 })]);
  res.json({
    parcours, regles,
    referentiel: { domaines: r.DOMAINES, priorites: r.PRIORITES, bornes: r.BORNES_PARAMETRES, actionsReco: r.ACTIONS_RECO, statutsParcours: r.STATUTS_PARCOURS },
    modifiable: r.ROLES_PARAMETRAGE.includes(req.soignant.role),
  });
};

// --- Parcours -----------------------------------------------------------------------------

exports.modifierParcours = async (req, res) => {
  await exigerParametrage(req);
  const p = await trouver(ParcoursRelance, req.params.code, 'Parcours');
  const d = objet(req.body);
  nouvelleVersion(p, ParcoursRelance, auteurDe(req.soignant));
  for (const k of ['libelle', 'definition', 'criteresEntree', 'criteresSortie', 'formuleIndicateur']) {
    if (d[k] !== undefined) p[k] = texte(d[k], 4000);
  }
  if (d.actionsAutorisees !== undefined) {
    p.actionsAutorisees = (Array.isArray(d.actionsAutorisees) ? d.actionsAutorisees : []).map((a) => texte(a, 200)).filter(Boolean).slice(0, 30);
  }
  if (d.delaiJours !== undefined) p.delaiJours = d.delaiJours === '' || d.delaiJours == null ? null : Number(d.delaiJours);
  // Toute modification du contenu doit être validée de nouveau.
  Object.assign(p, { statut: 'À valider', responsableValidation: '', referenceValidation: '', dateEffet: null });
  await valider(p);
  await p.save();
  await journaliser(req, { action: 'relance.parametrage', ressource: { type: 'parcours', id: p.code }, details: { version: p.version, statut: p.statut } });
  res.json(p);
};

exports.validerParcours = async (req, res) => {
  await exigerParametrage(req);
  const p = await trouver(ParcoursRelance, req.params.code, 'Parcours');
  const d = objet(req.body);
  const manquants = [['definition', 'la définition'], ['criteresEntree', 'les critères d’entrée'], ['criteresSortie', 'les critères de sortie'], ['formuleIndicateur', 'la formule d’indicateur']]
    .filter(([k]) => !p[k]).map(([, l]) => l);
  if (manquants.length) throw erreur(400, `Fiche incomplète : renseignez ${manquants.join(', ')} avant validation.`);
  const responsableValidation = texte(d.responsableValidation, 200);
  const referenceValidation = texte(d.referenceValidation, 300);
  if (!responsableValidation || !referenceValidation) throw erreur(400, 'Indiquez le responsable de la validation et la référence du document validé.');
  nouvelleVersion(p, ParcoursRelance, auteurDe(req.soignant));
  Object.assign(p, { statut: 'Validé', responsableValidation, referenceValidation, dateEffet: jour(d.dateEffet, 'Date d’effet') });
  await p.save();
  await journaliser(req, { action: 'relance.parametrage', ressource: { type: 'parcours', id: p.code }, details: { version: p.version, statut: p.statut } });
  res.json(p);
};

exports.suspendreParcours = async (req, res) => {
  await exigerParametrage(req);
  const p = await trouver(ParcoursRelance, req.params.code, 'Parcours');
  nouvelleVersion(p, ParcoursRelance, auteurDe(req.soignant));
  p.statut = 'Suspendu';
  await p.save();
  await journaliser(req, { action: 'relance.parametrage', ressource: { type: 'parcours', id: p.code }, details: { version: p.version, statut: p.statut } });
  res.json(p);
};

// --- Règles -------------------------------------------------------------------------------

exports.modifierRegle = async (req, res) => {
  await exigerParametrage(req);
  const regle = await trouver(RegleRelance, req.params.code, 'Règle');
  const d = objet(req.body);
  nouvelleVersion(regle, RegleRelance, auteurDe(req.soignant));
  if (d.libelle !== undefined) regle.libelle = texte(d.libelle, 200);
  if (d.description !== undefined) regle.description = texte(d.description, 1000);
  if (d.parcoursCode !== undefined) {
    const code = texte(d.parcoursCode, 12).toUpperCase() || null;
    if (code && !(await ParcoursRelance.exists({ code }))) throw erreur(400, 'Parcours inconnu.');
    regle.parcoursCode = code;
  }
  const p = objet(d.parametres);
  for (const [k, [min, max]] of Object.entries(r.BORNES_PARAMETRES)) {
    if (p[k] === undefined) continue;
    const n = Number(p[k]);
    if (!Number.isInteger(n) || n < min || n > max) throw erreur(400, `Paramètre « ${k} » : nombre entier de ${min} à ${max} attendu.`);
    regle.parametres[k] = n;
  }
  if (p.priorite !== undefined) {
    if (!r.PRIORITES.includes(p.priorite)) throw erreur(400, 'Priorité invalide.');
    regle.parametres.priorite = p.priorite;
  }
  Object.assign(regle, { statut: 'Inactive', responsableValidation: '', referenceProtocole: '', dateEffet: null });
  await valider(regle);
  await regle.save();
  await journaliser(req, { action: 'relance.parametrage', ressource: { type: 'regle', id: regle.code }, details: { version: regle.version, statut: regle.statut } });
  res.json(regle);
};

/** Activation : validation par un responsable, protocole RDC/PEV de référence, parcours validé. */
exports.activerRegle = async (req, res) => {
  await exigerParametrage(req);
  const regle = await trouver(RegleRelance, req.params.code, 'Règle');
  const d = objet(req.body);
  if (!regle.parcoursCode) throw erreur(400, 'Rattachez d’abord la règle à un parcours (RAC, ARC, RPC, IRC ou TCC).');
  const parcours = await ParcoursRelance.findOne({ code: regle.parcoursCode });
  if (parcours?.statut !== 'Validé') throw erreur(400, `Le parcours ${regle.parcoursCode} doit d’abord être validé.`);
  const responsableValidation = texte(d.responsableValidation, 200);
  const referenceProtocole = texte(d.referenceProtocole, 300);
  if (!responsableValidation || !referenceProtocole) throw erreur(400, 'Indiquez le responsable de la validation et le protocole RDC/PEV de référence.');
  nouvelleVersion(regle, RegleRelance, auteurDe(req.soignant));
  Object.assign(regle, { statut: 'Active', responsableValidation, referenceProtocole, dateEffet: jour(d.dateEffet, 'Date d’effet') });
  await regle.save();
  await journaliser(req, { action: 'relance.parametrage', ressource: { type: 'regle', id: regle.code }, details: { version: regle.version, statut: regle.statut } });
  res.json(regle);
};

exports.suspendreRegle = async (req, res) => {
  await exigerParametrage(req);
  const regle = await trouver(RegleRelance, req.params.code, 'Règle');
  nouvelleVersion(regle, RegleRelance, auteurDe(req.soignant));
  regle.statut = 'Suspendue';
  await regle.save();
  await journaliser(req, { action: 'relance.parametrage', ressource: { type: 'regle', id: regle.code }, details: { version: regle.version, statut: regle.statut } });
  res.json(regle);
};
