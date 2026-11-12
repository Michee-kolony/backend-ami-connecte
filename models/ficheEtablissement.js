// Schéma de la fiche AMI d'un établissement (étapes 1 à 10 du cahier des charges), intégrée au
// document Etablissement. Les champs déjà portés par l'établissement (nom, type, province, zones,
// aire, adresse, téléphone, e-mail, GPS) n'y sont pas répétés.
const mongoose = require('mongoose');
const { dateJour } = require('./commun');
const R = require('../config/ficheEtablissement');

const sansId = { _id: false };
const texte = () => ({ type: String, default: '', trim: true });
const choix = (liste) => ({ type: String, enum: [...liste, null], default: null });
const nombre = (max) => ({ type: Number, min: 0, ...(max ? { max } : {}), default: null });
const entier = (max) => ({
  ...nombre(max),
  validate: { validator: (v) => v == null || Number.isInteger(v), message: 'Nombre entier attendu.' },
});

const personneSchema = new mongoose.Schema({
  nom: texte(), postnom: texte(), prenom: texte(), fonction: texte(), telephone: texte(),
}, sansId);

const fichierSchema = new mongoose.Schema({ url: String, cle: String, nom: String }, sansId);

const acteurSchema = new mongoose.Schema({ type: { type: String, enum: ['comite', 'soignant'] }, id: String, nom: String }, sansId);

// Étape 1 (compléments de l'identité portée par l'établissement).
const identificationSchema = new mongoose.Schema({
  codeSnis: texte(),
  nomUsuel: texte(),
  sigle: texte(),
  niveauSanitaire: choix(R.NIVEAUX_SANITAIRES),
  categorie: choix(R.CATEGORIES),
  anneeCreation: entier(2100),
  dateOuverture: dateJour(),
  statutActuel: choix(R.STATUTS_ACTUELS),
  siteWeb: texte(),
}, sansId);

// Étape 2 (compléments de la localisation ; DPS et BCZS sont déduits).
const localisationSchema = new mongoose.Schema({
  pays: { type: String, default: 'RDC', trim: true },
  territoire: texte(),
  commune: texte(),
  quartier: texte(),
  reperes: texte(),
  distanceBczsKm: nombre(),
  distanceHgrKm: nombre(),
  distanceCsrKm: nombre(),
  tempsDeplacement: texte(),
  moyenTransport: texte(),
  accessibilitePluies: choix(R.ACCESSIBILITE),
  accessibiliteUrgence: choix(R.OUI_NON),
}, sansId);

// Étape 3.
const organisationSchema = new mongoose.Schema({
  statutJuridique: choix(R.STATUTS_JURIDIQUES),
  proprietaire: texte(),
  modeGestion: choix(R.MODES_GESTION),
  tutelleAdministrative: texte(),
  tutelleTechnique: texte(),
  autorisation: {
    type: new mongoose.Schema({ reference: texte(), date: dateJour(), piece: { type: fichierSchema, default: null } }, sansId),
    default: () => ({}),
  },
  agrement: { type: new mongoose.Schema({ numero: texte(), dateEcheance: dateJour() }, sansId), default: () => ({}) },
  responsable: { type: personneSchema, default: () => ({}) },
  responsableMedical: { type: personneSchema, default: () => ({}) },
  responsableInfirmier: { type: personneSchema, default: () => ({}) },
  responsableAdministratif: { type: personneSchema, default: () => ({}) },
  responsableMaternite: { type: personneSchema, default: () => ({}) },
  joursFonctionnement: { ...entier(7), min: 1 },
  horaires: texte(),
  garde: { type: new mongoose.Schema({ disponible: choix(R.OUI_NON), horaires: texte() }, sansId), default: () => ({}) },
}, sansId);

/** Changement de responsable : l'ancien est conservé, jamais écrasé. */
const changementResponsableSchema = new mongoose.Schema({
  role: String, ancien: personneSchema, nouveau: personneSchema, le: Date, par: acteurSchema,
}, sansId);

// Étape 4.
const infrastructuresSchema = new mongoose.Schema({
  batiments: entier(),
  salles: {
    type: new mongoose.Schema({ consultation: entier(), cpn: entier(), accouchement: entier(), vaccination: entier(), observation: entier() }, sansId),
    default: () => ({}),
  },
  litsTotal: entier(),
  litsFonctionnels: entier(),
  litsMaternite: entier(),
  blocOperatoire: choix(R.OUI_NON),
  laboratoire: choix(R.OUI_NON),
  pharmacie: choix(R.OUI_NON),
  morgue: choix(R.OUI_NON),
  salleAttente: choix(R.OUI_NON),
  toilettesTotal: entier(),
  toilettesFonctionnelles: entier(),
  pointEau: choix(R.OUI_NON),
  electricite: choix(R.OUI_NON),
  groupeElectrogene: choix(R.OUI_NON),
  chaineFroid: choix(R.OUI_NON),
}, sansId);

const equipementSchema = new mongoose.Schema({
  nom: { type: String, required: [true, 'Nom de l’équipement obligatoire.'], trim: true },
  categorie: texte(),
  total: { ...entier(), default: 0 },
  fonctionnels: { ...entier(), default: 0 },
  enPanne: { ...entier(), default: 0 },
  horsService: { ...entier(), default: 0 },
  dateAcquisition: dateJour(),
  etat: choix(R.ETATS_EQUIPEMENT),
  financement: texte(),
  derniereMaintenance: dateJour(),
  remplacement: choix(R.OUI_NON),
}, sansId);

// Étape 5 : registre du personnel (données nominatives : comité et médecin chef seulement).
const agentSchema = new mongoose.Schema({
  code: texte(),
  nom: { type: String, required: [true, 'Nom de l’agent obligatoire.'], trim: true },
  postnom: texte(),
  prenom: texte(),
  sexe: choix(['M', 'F']),
  profession: { type: String, enum: R.PROFESSIONS, required: [true, 'Profession de l’agent obligatoire.'] },
  specialite: texte(),
  qualification: texte(),
  numeroOrdre: texte(),
  fonction: texte(),
  service: texte(),
  contrat: choix(R.CONTRATS),
  statut: { type: String, enum: R.STATUTS_AGENT, default: 'Actif' },
  datePriseFonction: dateJour(),
  disponibilite: { type: String, enum: R.DISPONIBILITE, default: 'Disponible' },
  regime: choix(R.REGIMES),
}, sansId);

const effectifAttenduSchema = new mongoose.Schema({ profession: { type: String, enum: R.PROFESSIONS, required: true }, nombre: entier() }, sansId);

// Étape 6.
const serviceSchema = new mongoose.Schema({
  service: { type: String, enum: R.SERVICES_SANITAIRES, required: true },
  autorise: choix(R.OUI_NON),
  disponible: choix(R.OUI_NON),
  fonctionnel: choix(R.OUI_NON_PARTIEL),
  personnelQualifie: choix(R.OUI_NON),
  equipement: choix(R.DISPONIBILITE),
  joursActivite: entier(7),
  dateVerification: dateJour(),
}, sansId);

// Étape 7 : un enregistrement par année, les anciennes valeurs sont conservées.
const populationSchema = new mongoose.Schema({
  annee: { type: Number, required: true, min: 1950, max: 2100 },
  village: texte(),
  /** Population de responsabilité : base des cibles (étape 8). */
  totale: { ...entier(), required: [true, 'Population totale obligatoire.'] },
  administrative: entier(),
  frequentant: entier(),
  menages: entier(),
  urbaine: entier(),
  rurale: entier(),
  hommes: entier(),
  femmes: entier(),
  tranches: {
    type: new mongoose.Schema({ moins1: entier(), moins5: entier(), de5a14: entier(), de15a49: entier(), plus50: entier() }, sansId),
    default: () => ({}),
  },
  source: choix(R.SOURCES_POPULATION),
  dateCollecte: dateJour(),
  dateValidation: dateJour(),
  autorite: texte(),
  methode: texte(),
  saisiPar: { type: acteurSchema, default: null },
  saisiLe: { type: Date, default: null },
}, sansId);

// Étape 9.
const capacitesSchema = new mongoose.Schema({
  accueil: entier(),
  litsFonctionnels: entier(),
  accouchementsMois: entier(),
  cpnMois: entier(),
  seancesVaccinationMois: entier(),
  examensLaboPeriode: entier(),
  urgencesPeriode: entier(),
  vaccins: choix(R.OUI_NON),
  medicaments: choix(R.OUI_NON),
  personnelQualifie: choix(R.OUI_NON),
  electricite: choix(R.OUI_NON),
  eau: choix(R.OUI_NON),
  transportReference: choix(R.OUI_NON),
  communication: choix(R.OUI_NON),
}, sansId);

// Étape 10.
const etapeCircuitSchema = new mongoose.Schema({
  de: String, vers: String, action: String, motif: String, par: acteurSchema, le: Date,
}, sansId);

const circuitSchema = new mongoose.Schema({
  statut: { type: String, enum: R.STATUTS_CIRCUIT, default: 'Brouillon' },
  /**
   * Fiche ouverte pour un établissement enregistré avant la fiche AMI : ses modules restent
   * ouverts jusqu'à sa première activation (il fonctionnait déjà sur la plateforme).
   */
  anterieur: { type: Boolean, default: false },
  /** Auteurs de la saisie (membres du comité) : aucun ne peut vérifier la fiche. */
  auteurs: { type: [String], default: [] },
  controle: {
    type: new mongoose.Schema({ le: Date, erreurs: [String], avertissements: [String] }, sansId),
    default: null,
  },
  verification: {
    type: new mongoose.Schema({
      par: acteurSchema, nom: String, fonction: String, date: String, resultat: { type: String, enum: ['Conforme', 'Non conforme'] },
      observations: String,
    }, sansId),
    default: null,
  },
  /** Pièces justificatives de la vérification (stockage privé, liens signés à la lecture). */
  pieces: { type: [fichierSchema], default: [] },
  motifsCorrection: { type: [String], default: [] },
  validation: {
    type: new mongoose.Schema({ par: acteurSchema, nom: String, fonction: String, date: String, statutFinal: String }, sansId),
    default: null,
  },
  completude: { type: Number, default: 0 },
  qrCode: { type: String, default: null },
  activeLe: { type: Date, default: null },
  historique: { type: [etapeCircuitSchema], default: [] },
}, sansId);

const ficheSchema = new mongoose.Schema({
  identification: { type: identificationSchema, default: () => ({}) },
  localisation: { type: localisationSchema, default: () => ({}) },
  organisation: { type: organisationSchema, default: () => ({}) },
  historiqueResponsables: { type: [changementResponsableSchema], default: [] },
  infrastructures: { type: infrastructuresSchema, default: () => ({}) },
  equipements: { type: [equipementSchema], default: [] },
  agents: { type: [agentSchema], default: [] },
  effectifsAttendus: { type: [effectifAttenduSchema], default: [] },
  services: { type: [serviceSchema], default: [] },
  populations: { type: [populationSchema], default: [] },
  capacites: { type: capacitesSchema, default: () => ({}) },
  circuit: { type: circuitSchema, default: () => ({}) },
  /** Dernières modifications (qui, quelles sections). */
  modifications: {
    type: [new mongoose.Schema({ par: acteurSchema, le: Date, sections: [String] }, sansId)],
    default: [],
  },
}, sansId);

module.exports = { ficheSchema };
