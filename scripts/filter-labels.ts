const inputPath = Bun.argv[2] || "./labels.json";
const outputPath = Bun.argv[3] || "./filtered-labels.json";
const filterKey = Bun.argv[4];
const filterValue = Bun.argv[5];

const json = await Bun.file(inputPath).text();
const labels = JSON.parse(json);

let filtered = labels;

if (filterKey === "language" && filterValue) {
  filtered = filtered.filter((l: any) => l.primary_language === filterValue);
} else if (filterKey === "emotion" && filterValue) {
  filtered = filtered.filter((l: any) => l.emotion?.includes(filterValue));
} else if (filterKey === "region" && filterValue) {
  filtered = filtered.filter((l: any) => l.regions?.includes(filterValue));
} else if (filterKey === "reviewed" && filterValue) {
  filtered = filtered.filter((l: any) => l.reviewed === (filterValue === "true"));
} else if (filterKey === "nsfw" && filterValue) {
  filtered = filtered.filter((l: any) => l.safety?.nsfw === true);
}

await Bun.write(outputPath, JSON.stringify(filtered, null, 2));

console.log(`Filtered: ${labels.length} -> ${filtered.length}`);
console.log(`Saved to ${outputPath}`);