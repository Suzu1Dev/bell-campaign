import { Fragment } from "react";
import { parseMarkdownBlocks, type InlineSpan } from "../../shared/markdown";

function renderInlineSpans(spans: InlineSpan[]) {
  return spans.map((span, idx) => {
    if (span.type === "text") {
      return <Fragment key={idx}>{span.text}</Fragment>;
    }
    if (span.type === "code") {
      return <code key={idx}>{span.text}</code>;
    }
    if (span.type === "bold") {
      return <strong key={idx}>{renderInlineSpans(span.children)}</strong>;
    }
    if (span.type === "italic") {
      return <em key={idx}>{renderInlineSpans(span.children)}</em>;
    }
    return (
      <a key={idx} href={span.href} target="_blank" rel="noreferrer noopener">
        {span.label}
      </a>
    );
  });
}

export default function MarkdownPreview({ content }: { content: string }) {
  const blocks = parseMarkdownBlocks(content);
  if (blocks.length === 0) {
    return (
      <div className="md-preview">
        <p style={{ color: "var(--text-3)", margin: 0 }}>（尚無文字內容）</p>
      </div>
    );
  }

  return (
    <div className="md-preview">
      {blocks.map((block, bIdx) => {
        if (block.type === "heading") {
          const inner = renderInlineSpans(block.spans);
          if (block.level === 1) return <h1 key={bIdx}>{inner}</h1>;
          if (block.level === 2) return <h2 key={bIdx}>{inner}</h2>;
          if (block.level === 3) return <h3 key={bIdx}>{inner}</h3>;
          return <h4 key={bIdx}>{inner}</h4>;
        }
        if (block.type === "hr") {
          return <hr key={bIdx} />;
        }
        if (block.type === "code") {
          return (
            <pre key={bIdx}>
              <code>{block.content}</code>
            </pre>
          );
        }
        if (block.type === "blockquote") {
          return (
            <blockquote key={bIdx}>
              {block.lines.map((line, lIdx) => (
                <p key={lIdx}>{renderInlineSpans(line)}</p>
              ))}
            </blockquote>
          );
        }
        if (block.type === "table") {
          return (
            <div key={bIdx} className="md-table-wrap">
              <table>
                <thead>
                  <tr>
                    {block.headers.map((cell, cIdx) => (
                      <th key={cIdx} style={{ textAlign: block.alignments[cIdx] ?? "left" }}>
                        {renderInlineSpans(cell)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rIdx) => (
                    <tr key={rIdx}>
                      {block.headers.map((_, cIdx) => (
                        <td key={cIdx} style={{ textAlign: block.alignments[cIdx] ?? "left" }}>
                          {row[cIdx] ? renderInlineSpans(row[cIdx]) : null}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          const hasTasks = block.items.some((it) => it.checked !== null);
          return (
            <ListTag key={bIdx} className={hasTasks ? "md-task-list" : undefined}>
              {block.items.map((item, iIdx) => (
                <li key={iIdx} className={item.checked !== null ? "md-task-item" : undefined}>
                  {item.checked !== null && (
                    <span className={`md-task-box ${item.checked ? "is-checked" : ""}`} aria-hidden="true">
                      {item.checked ? "✓" : ""}
                    </span>
                  )}
                  <span>{renderInlineSpans(item.spans)}</span>
                </li>
              ))}
            </ListTag>
          );
        }
        return <p key={bIdx}>{renderInlineSpans(block.spans)}</p>;
      })}
    </div>
  );
}
