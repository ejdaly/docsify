import stripIndent from 'strip-indent';
import { get } from '../util/ajax.js';

const cached = {};

function walkFetchEmbed({ embedTokens, compile, fetch }, cb) {
  let token;
  let step = 0;
  let count = 0;

  if (!embedTokens.length) {
    return cb({});
  }

  while ((token = embedTokens[step++])) {
    const currentToken = token;

    const next = text => {
      let embedToken;
      if (text) {
        if (currentToken.embed.type === 'markdown') {
          let path = currentToken.embed.url.split('/');
          path.pop();
          path = path.join('/');
          // Resolves relative links to absolute
          text = text.replace(/\[([^[\]]+)\]\(([^)]+)\)/g, x => {
            const linkBeginIndex = x.indexOf('(');
            if (x.slice(linkBeginIndex, linkBeginIndex + 2) === '(.') {
              return (
                x.substring(0, linkBeginIndex) +
                `(${window.location.protocol}//${window.location.host}${path}/` +
                x.substring(linkBeginIndex + 1, x.length - 1) +
                ')'
              );
            }
            return x;
          });

          // This may contain YAML front matter and will need to be stripped.
          const frontMatterInstalled =
            ($docsify.frontMatter || {}).installed || false;
          if (frontMatterInstalled === true) {
            text = $docsify.frontMatter.parseMarkdown(text);
          }

          embedToken = compile.lexer(text);
        } else if (currentToken.embed.type === 'code') {
          if (currentToken.embed.fragment) {
            const fragment = currentToken.embed.fragment;
            const pattern = new RegExp(
              `(?:###|\\/\\/\\/)\\s*\\[${fragment}\\]([\\s\\S]*)(?:###|\\/\\/\\/)\\s*\\[${fragment}\\]`
            );

            // EJD - overloading the "lang" to allow you to specify what line of 
            // the code this refers to...
            // e.g. 
            //  ```ts :line=23
            //    var x = "x";
            //    ...
            //  ```
            // The purpose of this is to allow you to inform the Prism line-numbers plugin
            // (https://prismjs.com/plugins/line-numbers)
            // of what lines you are embedding from the file.
            // This requires a custom renderer in your docsify config, to parse these tags
            // and set the corresponding info on the <pre> tag (data-start=123), and
            // to then remove the tag from the lang
            //
            const match = text.match(pattern);

            // If we find a match based on `fragment` - find what line the first
            // matching [fragment] occurs..
            //
            if (match) {
              const line = text.slice(0, match.index).split("\n").length + 1;
              currentToken.embed.lang = `${currentToken.embed.lang} :line=${line}`;
              text = stripIndent((text.match(pattern) || [])[1] || '').trim();
            } else {
              text = "";
            }
          } else if (currentToken.embed.lines) {

            // EJD - if the title contains the `lines` config (e.g. ':include :lines=10-20'), then get
            // the correct lines to include (and the starting line), form that
            //
            const [ from, to ] = currentToken.embed.lines.split("-");
            currentToken.embed.lang = `${currentToken.embed.lang} :line=${from}`;
            text = stripIndent(text.split("\n").slice(from - 1, to).join("\n"));

            // EJD - if the last line is empty, the embed gets truncated by a line
            // So just put in a space to prevent that
            // (If you requested lines 10-20, you wouldn't want it truncated because line 20 is empty)
            //
            if (text.endsWith("\n")) {
              text = text + " ";
            }
          }

          embedToken = compile.lexer(
            '```' +
              currentToken.embed.lang +
              '\n' +
              text.replace(/`/g, '@DOCSIFY_QM@') +
              '\n```\n'
          );
        } else if (currentToken.embed.type === 'mermaid') {
          embedToken = [
            {
              type: 'html',
              text: /* html */ `<div class="mermaid">\n${text}\n</div>`,
            },
          ];
          embedToken.links = {};
        } else {
          embedToken = [{ type: 'html', text }];
          embedToken.links = {};
        }
      }

      cb({ token: currentToken, embedToken });
      if (++count >= embedTokens.length) {
        cb({});
      }
    };

    if (token.embed.url) {
      get(token.embed.url).then(next);
    } else {
      next(token.embed.html);
    }
  }
}

export function prerenderEmbed({ compiler, raw = '', fetch }, done) {
  let hit = cached[raw];
  if (hit) {
    const copy = hit.slice();
    copy.links = hit.links;
    return done(copy);
  }

  const compile = compiler._marked;
  let tokens = compile.lexer(raw);
  const embedTokens = [];
  const links = tokens.links;

  tokens.forEach((token, index) => {
    // EJD - I think there was a bug here.
    // We shouldn't need to reparse the tokens as "paragraphs" at this
    // point. They should already be parsed out to links etc...
    // So we just search for token.tokens.type === "link"
    //
    const { tokens = [] } = token;
    tokens.forEach(token => {
      if (token.type === "link") {
        const { href, title } = token;
        const embed = compiler.compileEmbed(href, title);
        if (embed) {
          embedTokens.push({
            index,
            embed,
          });
        }
      }
    })
  });

  // keep track of which tokens have been embedded so far
  // so that we know where to insert the embedded tokens as they
  // are returned
  const moves = [];
  walkFetchEmbed({ compile, embedTokens, fetch }, ({ embedToken, token }) => {
    if (token) {
      // iterate through the array of previously inserted tokens
      // to determine where the current embedded tokens should be inserted
      let index = token.index;
      moves.forEach(pos => {
        if (index > pos.start) {
          index += pos.length;
        }
      });

      Object.assign(links, embedToken.links);

      // EJD - if you embed (via a link), then leave the link
      // in place, so that you can open the actual document also
      // if you like...
      //
      tokens = tokens
        .slice(0, index + 1)
        .concat(embedToken, tokens.slice(index + 1));
      moves.push({ start: index + 1, length: embedToken.length });
    } else {
      cached[raw] = tokens.concat();
      tokens.links = cached[raw].links = links;
      done(tokens);
    }
  });
}
