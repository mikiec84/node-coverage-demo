'use strict';
const inspector = require('inspector');
const http = require('http');
const query = require('querystring');
const fs = require('fs');

inspector.Session.prototype.postAsync = function(...args) {
  let session = this;
  return new Promise(
    function(resolve, reject) {
      session.post(...args,
        function(error, result) {
          if (error !== null) {
            reject(error);
          } else if (result.exceptionDetails !== undefined) {
            reject(result.exceptionDetails.exception.description);
          } else {
            resolve(result);
          }
        });
    });
};

async function ReadFile(file_name) {
  return new Promise(
    function(resolve, reject) {
      fs.readFile(file_name, "utf8", function(error, result) {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
}

// Reformat string for HTML.
function Escape(string) {
  return [
    ["&", "&amp;"],
    [" ", "&nbsp;"],
    ["<", "&lt;"],
    [">", "&gt;"],
    ["\r\n", "<br/>"],
    ["\n", "<br/>"],
    ["\"", "&quot;"],
  ].reduce(
    function(string, [pattern, replacement]) {
      return string.replace(new RegExp(pattern, "g"), replacement);
    }, string);
}

async function CollectProfile(source) {
  // Open a new inspector session.
  const session = new inspector.Session();
  let messages = [];
  let profile = undefined;
  try {
    session.connect();
    // Enable relevant inspector domains.
    await session.postAsync('Runtime.enable');
    await session.postAsync('Profiler.enable');
    await session.postAsync('Profiler.startTypeProfile');
    // Compile script.
    let { scriptId } = await session.postAsync('Runtime.compileScript', {
      expression: source,
      sourceURL: "test",
      persistScript: true
    });
    
    // Collect console log during execution.
    session.on('Runtime.consoleAPICalled',
      message => messages.push(message));
    // Execute script.
    await session.postAsync('Runtime.runScript', { scriptId });
    await session.postAsync('HeapProfiler.collectGarbage');
    // Collect and filter coverage result.
    let { result } = await session.postAsync('Profiler.takeTypeProfile');
    profile = result.filter(x => x.scriptId == scriptId);
    await session.postAsync('Profiler.stopTypeProfile');
    await session.postAsync('Profiler.disable');
    await session.postAsync('Runtime.disable');
  } finally {
    // Close session and return.
    session.disconnect();
  }
  return [profile, messages];
}

function MarkUpCode(profile, source) {
  let entries = profile.reduce(
    (result, next) => result = result.concat(next.entries), []);
  entries.sort(function({ offset: ao }, { offset: bo }) {
    return ao-bo;
  });
  let result = "";
  let cursor = 0;

  // Helper functions.
  function CopySourceUpTo(up_to) {
    result += Escape(source.substring(cursor, up_to));
    cursor = up_to;
  }

  function PrintType(type) {
    result += `<span style="background-color: rgb(255, 0, 0); color: white"`;
    result += ">";
    result += type.name;
    result += "</span>";
    result += " "
  }

  // Iterate ranges and reconstruct nesting.
  for (let entry of entries) {
    CopySourceUpTo(entry.offset);
    for (let type of entry.types) {
      PrintType(type);
    }
  }
  CopySourceUpTo(source.length);
  return result;
}

async function GetPostBody(request) {
  return new Promise(function(resolve) {
    let body = "";
    request.on('data', data => body += data);
    request.on('end', end => resolve(query.parse(body)));
  });
}

async function Server(request, response) {
  let script = "";
  let result = "";
  let message_log = "";
  if (request.method == 'POST') {
    // Collect coverage on the script from input form.
    try {
      let post = await GetPostBody(request);
      script = post.script;
      let [profile, messages] = await CollectProfile(script);
      result = MarkUpCode(profile, script);
      for (let message of messages) {
        message_log += `console.${message.params.type}: `;
        message_log += `${message.params.args[0].value}<br/>`;
      }
    } catch (e) {
      message_log = Escape(e.toString());
    }
  } else {
    // Use example file.
    script = await ReadFile("typeprofile/example.js");
  }
  let template = await ReadFile("typeprofile/template.html");
  let html = [
    ["SCRIPT", script],
    ["RESULT", result],
    ["CONSOLE", message_log],
  ].reduce(function(template, [pattern, replacement]) {
    return template.replace(pattern, replacement);
  }, template);
  response.writeHead(200, {
    'Content-Type': 'text/html'
  });
  response.end(html);
}

http.createServer(Server).listen(8080);

