// DOCX -> HTML (mammoth, keeps headings/lists/tables/bold/italic/links) -> Markdown (Turndown).
import mammoth from 'mammoth';
import { htmlToMarkdown } from './html.js';

const STYLE_MAP = [
    "p[style-name='Title'] => h1:fresh",
    "p[style-name='Subtitle'] => h2:fresh",
    "p[style-name='Quote'] => blockquote:fresh",
    "p[style-name='Intense Quote'] => blockquote:fresh",
];

export async function convertDocx(buffer) {
    const result = await mammoth.convertToHtml({ buffer }, {
        styleMap: STYLE_MAP,
        // Drop embedded images (base64 would bloat the output and is useless for text models).
        convertImage: mammoth.images.imgElement(async (image) => ({ src: '', alt: image.altText || '' })),
    });
    const { markdown } = htmlToMarkdown(result.value, { fullPage: false });
    const title = (markdown.match(/^# (.+)$/m) || [])[1] || '';
    const warnings = result.messages
        .filter((m) => m.type === 'error')
        .slice(0, 5)
        .map((m) => `DOCX: ${m.message}`);
    return { title, markdown, warnings };
}
