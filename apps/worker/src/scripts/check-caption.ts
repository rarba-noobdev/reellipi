/**
 * Exercise caption generation alone, without paying for STT or a render.
 * Reuses a stored project's transcript.
 *
 *   npx tsx src/scripts/check-caption.ts <projectId>
 */
import { readCues, listProjects } from '../lib/localstore.js';
import { styleCues } from '../jobs/style.js';

const arg = process.argv[2];
const projects = await listProjects();
const project = arg ? projects.find((p) => p.id.startsWith(arg)) : projects.find((p) => p.status === 'done');
if (!project) throw new Error('No completed local project found. Upload one first.');

const cues = await readCues(project.id);
const words = cues.flatMap((c) => c.words);
if (words.length === 0) throw new Error('That project has no stored cues.');

console.log(`project : ${project.title} (${project.id.slice(0, 8)})`);
console.log(`words   : ${words.length}\n`);

const styled = await styleCues(words, {
  languageCode: project.detectedLanguage,
  mediaDuration: project.durationSeconds ?? undefined,
});

console.log(`llmApplied : ${styled.llmApplied}${styled.warning ? `  (${styled.warning})` : ''}`);
console.log('\n--- caption ---');
console.log(styled.igCaption || '(empty)');
console.log('\n--- hashtags ---');
console.log(styled.hashtags.map((h) => `#${h}`).join(' ') || '(none)');

const firstLine = styled.igCaption.split('\n')[0] ?? '';
console.log('\n--- checks ---');
console.log(`  hook length <=125 : ${firstLine.length <= 125 ? 'PASS' : 'FAIL'} (${firstLine.length})`);
console.log(`  total <=300       : ${styled.igCaption.length <= 300 ? 'PASS' : 'FAIL'} (${styled.igCaption.length})`);
console.log(`  8 hashtags        : ${styled.hashtags.length === 8 ? 'PASS' : `FAIL (${styled.hashtags.length})`}`);
const banned = ['viral', 'fyp', 'explorepage', 'trending', 'followforfollow', 'like4like'];
const found = styled.hashtags.filter((h) => banned.includes(h));
console.log(`  no spam tags      : ${found.length === 0 ? 'PASS' : `FAIL (${found.join(', ')})`}`);
