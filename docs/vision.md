# Vermieter Cockpit DE

Version: 0.1 (Draft)
Status: Living Document

---

# Vision

## Mission

Vermieter Cockpit DE ist eine selbst gehostete Open-Source-Plattform für private Immobilieninvestoren in Deutschland.

Das Ziel ist nicht die klassische Hausverwaltung, sondern ein System, das Vermietung, Finanzierung, Steuer und Investmentanalyse in einer einzigen konsistenten Datenbasis vereint.

Jede Information soll genau einmal erfasst werden und anschließend automatisch für unterschiedliche fachliche Sichten genutzt werden.

---

# Vision Statement

Wir möchten das Betriebssystem für private Immobilieninvestoren schaffen.

Während klassische Vermietersoftware vor allem die Verwaltung von Mietern und Zahlungen unterstützt und Buchhaltungssoftware ausschließlich finanzielle Vorgänge betrachtet, verbindet Vermieter Cockpit DE beide Welten.

Das System versteht eine Immobilie gleichzeitig als

- Vermietungsobjekt
- Finanzierungsobjekt
- Steuerobjekt
- Investment

und ermöglicht dadurch eine deutlich höhere Transparenz über Vermögen, Liquidität und Rendite.

---

# Zielgruppe

Die Software richtet sich an:

- private Immobilieninvestoren
- Eigentümer vermieteter Wohnungen
- Eigentümer kleiner Mehrfamilienhäuser
- Buy-and-Hold Investoren
- langfristige Bestandshalter

Nicht Zielgruppe sind:

- Immobilienmakler
- Hausverwaltungen
- Bauträger
- Projektentwickler
- Ferienwohnungsanbieter
- Hotelbetreiber

---

# Philosophie

Eine Immobilie ist kein statisches Objekt.

Sie verändert sich kontinuierlich durch

- Finanzierungen
- Tilgungen
- Mieteinnahmen
- Instandhaltungen
- Modernisierungen
- Marktwertentwicklungen
- steuerliche Effekte

Diese Veränderungen sollen vollständig nachvollziehbar sein.

---

# Kernidee

Es existiert nur eine finanzielle Wahrheit.

Aus derselben Datenbasis entstehen unterschiedliche fachliche Perspektiven.

Zum Beispiel:

Transaktion

↓

Cashflow

↓

Steuer

↓

Investment

↓

Reporting

Nicht mehrere Datensätze.

Nicht mehrere Berechnungen.

Nicht mehrere Excel-Dateien.

---

# Leitprinzipien

## Single Source of Truth

Jede Information wird genau einmal gespeichert.

Alle Berechnungen greifen auf dieselben Daten zu.

---

## Reproduzierbarkeit

Jede Zahl muss nachvollziehbar sein.

Es darf keine "magischen" Berechnungen geben.

---

## Explainability

Das System muss jede Kennzahl erklären können.

Nicht nur:

Cashflow = 184 €

sondern

Cashflow = Miete
− nicht umlagefähige Kosten
− Zinsen
− Tilgung

---

## Composition over Modification

Bestehende Open-Source-Komponenten werden erweitert.

Nicht unnötig verändert.

MicroRealEstate bleibt der operative Vermietungskern.

Eigene Funktionen entstehen in separaten Modulen.

---

## Long-Term Thinking

Das System wird für Jahrzehnte gebaut.

Nicht für eine Steuererklärung.

Nicht für einen einzelnen Wohnungskauf.

---

## Self Hosted First

Alle Daten gehören dem Eigentümer.

Keine Cloud-Abhängigkeit ist erforderlich.

Die Software muss vollständig selbst betrieben werden können.

---

## Open Source

Alle Kernfunktionen sollen offen nachvollziehbar sein.

Geschäftslogik darf nicht verborgen sein.

---

## Auditability

Jede Berechnung muss vollständig nachvollziehbar sein.

Insbesondere für

- Steuer
- Finanzierung
- AfA
- Rendite

---

## AI is an Assistant

Künstliche Intelligenz unterstützt den Benutzer.

Sie ersetzt niemals das Datenmodell.

Sie schreibt niemals ungeprüfte Daten in die Datenbank.

---

# Was das System NICHT sein soll

Keine klassische Buchhaltungssoftware.

Keine ERP-Lösung.

Kein CRM.

Kein Maklersystem.

Keine Hausverwaltungssoftware.

Keine ELSTER-Software.

Keine Steuerberatungssoftware.

Keine Bewertungssoftware.

Keine Banking-App.

Diese Funktionen können integriert oder angebunden werden.

Sie sind jedoch nicht Kern des Systems.

---

# Fachliche Säulen

Das Produkt besteht aus vier gleichwertigen Säulen.

1. Vermietung

Verträge

Mieter

Kommunikation

Dokumente

2. Finanzen

Transaktionen

Bank

Darlehen

Belege

Cashflow

3. Steuer

AfA

Werbungskosten

Anschaffungskosten

WEG

Steuerreports

4. Investment

Eigenkapital

Rendite

NOI

IRR

Szenarien

Portfolio

Keine Säule besitzt ihre eigenen Finanzdaten.

Alle greifen auf dieselben Transaktionen zu.

---

# Langfristige Vision

Eine Person soll ihr gesamtes Immobilienportfolio ausschließlich mit Vermieter Cockpit DE verwalten können.

Von der ersten Eigentumswohnung bis zu einem Portfolio aus mehreren Objekten.

Dabei soll das System jederzeit beantworten können:

Wie hoch ist mein Vermögen?

Wie entwickelt sich mein Eigenkapital?

Wie viel Liquidität erwirtschaften meine Immobilien?

Welche Finanzierung läuft wann aus?

Wie hoch ist meine tatsächliche Rendite?

Welche Investitionen waren erfolgreich?

Welche Maßnahmen haben den größten Wert geschaffen?

Welche Auswirkungen hätte eine Anschlussfinanzierung?

Welche steuerlichen Auswirkungen ergeben sich?

Ohne dass dieselben Informationen mehrfach gepflegt werden müssen.

---

# Qualitätsanspruch

Lieber weniger Funktionen,

die fachlich korrekt,

nachvollziehbar,

und langfristig wartbar sind,

als möglichst viele Features.

Korrektheit ist wichtiger als Geschwindigkeit.

Nachvollziehbarkeit ist wichtiger als Automatisierung.

Einfachheit ist wichtiger als Funktionsfülle.

---

# Motto

Eine Immobilie ist mehr als ein Mietvertrag.

Sie ist ein langfristiges Investment.

Die Software soll genau das verstehen.