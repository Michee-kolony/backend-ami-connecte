// Référentiels partagés par l'API et le tableau de bord (source unique : le front les charge d'ici).

/**
 * Les 26 provinces de la RDC (Constitution de 2006, découpage effectif depuis 2015).
 * Mêmes libellés que la carte du tableau de bord (ami-sante/src/app/admin/data/carte-rdc.ts),
 * pour pouvoir regrouper les dossiers par province dans les analyses.
 */
const PROVINCES_RDC = [
  'Bas-Uele', 'Équateur', 'Haut-Katanga', 'Haut-Lomami', 'Haut-Uele', 'Ituri', 'Kasaï', 'Kasaï-Central',
  'Kasaï-Oriental', 'Kinshasa', 'Kongo-Central', 'Kwango', 'Kwilu', 'Lomami', 'Lualaba', 'Mai-Ndombe',
  'Maniema', 'Mongala', 'Nord-Kivu', 'Nord-Ubangi', 'Sankuru', 'Sud-Kivu', 'Sud-Ubangi', 'Tanganyika',
  'Tshopo', 'Tshuapa',
];

module.exports = { PROVINCES_RDC };
