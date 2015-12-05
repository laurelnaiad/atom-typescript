import project = require('../core/project');
import mkdirp = require('mkdirp');
import path = require('path');
import fs = require('fs');
import {pathIsRelative, makeRelativePath} from "../../tsconfig/tsconfig";
import {consistentPath} from "../../utils/fsUtil";
import {createMap, assign} from "../utils";
var findup = require('findup');

/** Lazy loaded babel tanspiler */
let babels: { [key: string]: any } = {};
/** Store babel configurations from .babelrc */
let babelConfigs: { [key: string]: any } = {};

/** If we get a compile request for a ts file that is not in project. We return a js file with the following content */
export const Not_In_Context = "/* NotInContext */";

export function diagnosticToTSError(diagnostic: ts.Diagnostic): CodeError {
    var filePath = diagnostic.file.fileName;
    var startPosition = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    var endPosition = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start + diagnostic.length);

    return {
        filePath: filePath,
        startPos: { line: startPosition.line, col: startPosition.character },
        endPos: { line: endPosition.line, col: endPosition.character },
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        preview: diagnostic.file.text.substr(diagnostic.start, diagnostic.length),
    };
}

export function emitFile(proj: project.Project, filePath: string): EmitOutput {
    var services = proj.languageService;
    var output = services.getEmitOutput(filePath);
    var emitDone = !output.emitSkipped;
    var errors: CodeError[] = [];

    let sourceFile = services.getSourceFile(filePath);

    // Emit is no guarantee that there are no errors
    // so lets collect those
    var allDiagnostics = services.getCompilerOptionsDiagnostics()
        .concat(services.getSyntacticDiagnostics(filePath))
        .concat(services.getSemanticDiagnostics(filePath));
    allDiagnostics.forEach(diagnostic => {
        // happens only for 'lib.d.ts' for some reason
        if (!diagnostic.file) return;

        var startPosition = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        errors.push(diagnosticToTSError(diagnostic));
    });

    if (!output.emitSkipped) {
      /**
       * Run an external transpiler
       */
      {
          let sourceMapContents: { [index: string]: any } = {};
          output.outputFiles.forEach(o => {
              mkdirp.sync(path.dirname(o.name));
              var additionalEmits = runExternalTranspilerSync(
                  filePath,
                  sourceFile.text,
                  o,
                  proj,
                  sourceMapContents,
                  errors
              );
              if (!sourceMapContents[o.name] && !proj.projectFile.project.compilerOptions.noEmit) {
                  // .js.map files will be written as an "additional emit" later.
                  fs.writeFileSync(o.name, o.text, "utf8");
              }

              if (additionalEmits) {
                additionalEmits.forEach(a => {
                    mkdirp.sync(path.dirname(a.name));
                    fs.writeFileSync(a.name, a.text, "utf8");
                });
              }
          });
      }


    }
    else {
      console.error(errors);
    }

    var outputFiles = output.outputFiles.map((o) => o.name);
    if (path.extname(filePath) == '.d.ts') {
        outputFiles.push(filePath);
    }

    // // There is no *official* emit output for a `d.ts`
    // // but its nice to have a consistent world view in the rest of our code
    // console.error(outputFiles);
    // why this?
    // if (path.extname(filePath) == '.d.ts') {
    //     outputFiles.push(filePath);
    // }

    return {
        sourceFileName: filePath,
        outputFiles: outputFiles,
        success: emitDone && !errors.length,
        errors: errors,
        emitError: !emitDone
    };
}
export function getRawOutput(proj: project.Project, filePath: string): ts.EmitOutput {
    let services = proj.languageService;
    let output: ts.EmitOutput;
    if (proj.includesSourceFile(filePath)) {
        output = services.getEmitOutput(filePath);
    } else {
        output = {
            outputFiles: [{ name: filePath, text: Not_In_Context, writeByteOrderMark: false }],
            emitSkipped: true
        }
    }
    return output;
}

export function getRawOutputPostExternal(proj: project.Project, filePath: string): ts.EmitOutput {
  let services = proj.languageService;
  let output: ts.EmitOutput;
  if (proj.includesSourceFile(filePath)) {
      output = services.getEmitOutput(filePath);
      if (output.outputFiles.length) {
        let sourceFile = proj.languageService.getSourceFile(filePath);
        let sourceMapContents: { [index: string]: any } = {};
        let errs = [];
        var addionalFiles = runExternalTranspilerSync(
          filePath, sourceFile.text, output.outputFiles[0], proj, sourceMapContents, errs
        );
        if (errs.length) {
          return {
              outputFiles: [],
              emitSkipped: false
              // errors: errs,
              // emitSkipped: output.emitSkipped
          };
        }
        else {
          return {
              outputFiles: output.outputFiles,
              emitSkipped: output.emitSkipped
          };
        }
      }
      else {
        return output;
      }
  } else {
      output = {
          outputFiles: [{ name: filePath, text: Not_In_Context, writeByteOrderMark: false }],
          emitSkipped: true
      }
      return output;
  }
}

// babels[projectDirectory] =
// require('/Users/dmaddox/Documents/_ws/atom-typescript/node_modules/babel/index.js')

function getBabelInstanceSync(projectDirectory: string) {
    if (!babels[projectDirectory]) {
      let dir;

      dir = '/Users/dmaddox/Documents/_ws/atom-typescript/node_modules/babel-core';
      babels[projectDirectory] = require(dir);
      // try {
      //   dir = findup.sync(projectDirectory, 'node_modules/babel-core');
      //
      //   babels[projectDirectory] = require(path.join(dir, 'node_modules/babel-core'));
      // } catch (err) {
      //   try {
      //     dir = findup.sync(projectDirectory, 'node_modules/babel');
      //     babels[projectDirectory] = require(path.join(dir, 'node_modules/babel'));
      //   } catch (e) {
      //     babels[projectDirectory] = require('babel');
      //   }
      // }

      var babelrcDir;
      try {
        babelrcDir = findup.sync(projectDirectory, '.babelrc');
        var data = fs.readFileSync(path.join(babelrcDir, '.babelrc'));
        babelConfigs[projectDirectory] = JSON.parse(data.toString());
      } catch (e) {}
    }
    return babels[projectDirectory];
}

// babels[projectDirectory] =
//   require('/Users/dmaddox/Documents/_ws/atom-typescript/node_modules/babel/index.js')
// resolve(babels[projectDirectory]);

function getBabelInstance(projectDirectory: string) {
    return new Promise<any>(resolve => {
        if (!babels[projectDirectory]) {
            findup(projectDirectory, 'node_modules/babel-core', function(err: any, dir: string) {
                if (err) {
                    findup(projectDirectory, 'node_modules/babel', function(err: any, dir: string) {
                        if (err) {
                            console.error('just require');
                            console.error(require.resolve('babel'));

                            babels[projectDirectory] = require('babel');
                        } else {
                            console.error(dir);
                            babels[projectDirectory] = require(path.join(dir, 'node_modules/babel'));
                        }
                        resolve(babels[projectDirectory]);
                    });
                } else {
                    console.error(dir);
                    babels[projectDirectory] = require(path.join(dir, 'node_modules/babel-core'));
                    resolve(babels[projectDirectory]);
                }
            });
        } else {
            resolve(babels[projectDirectory]);
        }
    }).then(babel => {
        return new Promise<any>(resolve => {
            findup(projectDirectory, '.babelrc', function(err: any, dir) {
                if (err) return resolve(babel);

                fs.readFile(path.join(dir, '.babelrc'), function(err, data) {
                    try {
                        babelConfigs[projectDirectory] = JSON.parse(data.toString());
                    } catch (e) { }

                    resolve(babel);
                });
            });
        });
    });
}

/**
 * Given output from a tsc transpile of a file, transpile each of its
 * outputs in a second transpiler.
 * @param  {string}          sourceFileName The original file path
 * @param  {string}          sourceFileText The original file content
 * @param  {ts.OutputFile}   outputFile     The output of the original transpile.
 * Mutated on succesful transpile in babel
 * @param  {project.Project} project        The relevant project for the file
 * @param  {any          }}            sourceMapContents
 * @param  {CodeError[]}     errors         List of errors already encountered
 * Mutated if errors are encountered in babel.
 * @return {ts.OutputFile[]}                List of new output files generated
 */
function runExternalTranspilerSync(
    sourceFileName: string,
    sourceFileText: string,
    outputFile: ts.OutputFile,
    project: project.Project,
    sourceMapContents: { [index: string]: any },
    errors: CodeError[]
): ts.OutputFile[]
{
    if (!isJSFile(outputFile.name) && !isJSSourceMapFile(outputFile.name)) {
      return [];
    }

    let settings = project.projectFile.project;
    let externalTranspiler = settings.externalTranspiler;
    if (!externalTranspiler) {
        return [];
    }

    if (isJSSourceMapFile(outputFile.name)) {
        let sourceMapPayload = JSON.parse(outputFile.text);
        let jsFileName = consistentPath(path.resolve(path.dirname(outputFile.name), sourceMapPayload.file));
        sourceMapContents[outputFile.name] = { jsFileName: jsFileName, sourceMapPayload };
        return [];
    }

    if (typeof externalTranspiler === 'string') {
        externalTranspiler = {
            name: externalTranspiler as string,
            options: {}
        }
    }
    console.error('wtf?');

    // We need this type guard to narrow externalTranspiler's type
    if (typeof externalTranspiler === 'object') {
        if (externalTranspiler.name.toLocaleLowerCase() === "babel") {
            var babel = getBabelInstanceSync(project.projectFile.projectFileDirectory);
            let babelOptions: any = assign(
              babelConfigs[project.projectFile.projectFileDirectory] || {},
              externalTranspiler.options || {},
              {
                filename: outputFile.name
              }
            );

            let sourceMapFileName = getJSMapNameForJSFile(outputFile.name);

            if (sourceMapContents[sourceMapFileName]) {
                babelOptions.inputSourceMap = sourceMapContents[sourceMapFileName].sourceMapPayload;
                let baseName = path.basename(sourceFileName);
                // NOTE: Babel generates invalid source map without consistent `sources` and `file`.
                babelOptions.inputSourceMap.sources = [baseName];
                babelOptions.inputSourceMap.file = baseName;
            }
            if (settings.compilerOptions.sourceMap) {
                babelOptions.sourceMaps = true;
            }
            if (settings.compilerOptions.inlineSourceMap) {
                babelOptions.sourceMaps = "inline";
            }
            if (!settings.compilerOptions.removeComments) {
                babelOptions.comments = true;
            }

            let babelResult;
            try {
              let directory = process.cwd();
              process.chdir(project.projectFile.projectFileDirectory);
              babelResult = babel.transform(outputFile.text, babelOptions);
              process.chdir(directory);
              outputFile.text = babelResult.code;
            }
            catch (err) {
              console.error('err' + err.toString());
              var codeErr: CodeError = {
                filePath: outputFile.name,
                startPos: {line: 0, col: 0},
                endPos: {line: 0, col: 0},
                message: '',
                preview: ''
              };

              /* Example for regexp
              SyntaxError: /pathToFile.js: Unexpected token (4:9)
                  2 | var gulpSourcemap
              */
              var parse1 = /^([^:]*):\s([^:]*):\s([^:]*)\s\((\d*):(\d*)\)(([\r|\r\n]*[^\r|\r\n]*)*)$/m;
                // (yields)
                // 1: "SyntaxError"
                // 2: "/pathToFile.js"
                // 3: "Unexpected Token"
                // 4: "4"
                // 5: "9"
                // 6: "\r\n<lineOne>\r\n<lineTwo>....etc"

              // more relaxed parser, doesn't try to grok line/col -- need to confirm expected formats
              var parse2 = /^([^:]*):\s([^:]*):\s*(.*)(([\r|\r\n]|.)*)$/m;
              //   (yields)
              //   1: "SyntaxError"
              //   2: "/pathToFile.js"
              //   3: "Unexpected Token (4:9)"
              //   4: "\r\n<lineOne>\r\n<lineTwo>....etc"

              codeErr.preview = 'The Typescript compiler emitted Javascript \
                  that the Babel compiler could not parse.';

              var matches = parse1.exec(err.toString());
              if (matches && matches.length) {
                codeErr.filePath = matches[2];
                codeErr.startPos.line = parseInt(matches[4]);
                codeErr.startPos.col = parseInt(matches[5]);
                codeErr.endPos.line = codeErr.startPos.line;
                codeErr.endPos.col = codeErr.startPos.col;

                codeErr.preview = matches[6];

                codeErr.message = matches[1] + ': ' + matches[4] + ':' + matches[5] + ' (Babel)';
              }
              else {
                matches = parse2.exec(err.toString());
                if (matches && matches.length) {
                  codeErr.filePath = matches[2];
                  codeErr.startPos.line = 0; //parseInt(matches[4]);
                  codeErr.startPos.col = 0; // parseInt(matches[5]);
                  codeErr.endPos.line = codeErr.startPos.line;
                  codeErr.endPos.col = codeErr.startPos.col;
                  codeErr.preview = 'Could not parse line/col number\n\n' +
                      matches[4];
                }
                else {
                  console.error('nothing looks parseable');
                  console.error(err.toString());
                  console.error(err.stack);
                  codeErr.filePath = null;
                  codeErr.startPos.line = 0; //parseInt(matches[4]);
                  codeErr.startPos.col = 0; // parseInt(matches[5]);
                  codeErr.endPos.line = codeErr.startPos.line;
                  codeErr.endPos.col = codeErr.startPos.col;
                  codeErr.preview = err.toString();
                  codeErr.message = 'Unparseable Babel problem.'
                }
              }
              errors.push(codeErr);
            }

            if (babelResult) {
              console.log('result!');
            }
            if (babelResult && babelResult.map) {
              let additionalEmit: ts.OutputFile = {
                  name: sourceMapFileName,
                  text: JSON.stringify(babelResult.map),
                  writeByteOrderMark: settings.compilerOptions.emitBOM
              };
              if (additionalEmit.name === "") {
                  // can't emit a blank file name - this should only be reached if the TypeScript
                  // language service returns the .js file before the .js.map file.
                  console.warn(`The TypeScript language service did not yet provide a .js.map name for file ${outputFile.name}`);
                  return [];
              }

              return [additionalEmit];
            }
            else {
              return [];

            }

        }
    }

    function getJSMapNameForJSFile(jsFileName: string) {
        for (let jsMapName in sourceMapContents) {
            if (sourceMapContents.hasOwnProperty(jsMapName)) {
                if (sourceMapContents[jsMapName].jsFileName === jsFileName) {
                    return jsMapName;
                }
            }
        }
        return "";
    }

}



function runExternalTranspiler(sourceFileName: string,
    sourceFileText: string,
    outputFile: ts.OutputFile,
    project: project.Project,
    sourceMapContents: { [index: string]: any }
): Promise<ts.OutputFile[]> {
    console.error('runit');

    if (!isJSFile(outputFile.name) && !isJSSourceMapFile(outputFile.name)) {
        return Promise.resolve([]);
    }

    let settings = project.projectFile.project;
    let externalTranspiler = settings.externalTranspiler;
    if (!externalTranspiler) {
        return Promise.resolve([]);
    }

    if (isJSSourceMapFile(outputFile.name)) {
        let sourceMapPayload = JSON.parse(outputFile.text);
        let jsFileName = consistentPath(path.resolve(path.dirname(outputFile.name), sourceMapPayload.file));
        sourceMapContents[outputFile.name] = { jsFileName: jsFileName, sourceMapPayload };
        return Promise.resolve([]);
    }

    if (typeof externalTranspiler === 'string') {
        externalTranspiler = {
            name: externalTranspiler as string,
            options: {}
        }
    }

    // We need this type guard to narrow externalTranspiler's type
    if (typeof externalTranspiler === 'object') {
        if (externalTranspiler.name.toLocaleLowerCase() === "babel") {
            return getBabelInstance(project.projectFile.projectFileDirectory).then((babel) => {

                let babelOptions: any = assign(
                  babelConfigs[project.projectFile.projectFileDirectory] || {},
                  externalTranspiler.options || {},
                  {
                    filename: outputFile.name
                  }
                );

                let sourceMapFileName = getJSMapNameForJSFile(outputFile.name);

                if (sourceMapContents[sourceMapFileName]) {
                    babelOptions.inputSourceMap = sourceMapContents[sourceMapFileName].sourceMapPayload;
                    let baseName = path.basename(sourceFileName);
                    // NOTE: Babel generates invalid source map without consistent `sources` and `file`.
                    babelOptions.inputSourceMap.sources = [baseName];
                    babelOptions.inputSourceMap.file = baseName;
                }
                if (settings.compilerOptions.sourceMap) {
                    babelOptions.sourceMaps = true;
                }
                if (settings.compilerOptions.inlineSourceMap) {
                    babelOptions.sourceMaps = "inline";
                }
                if (!settings.compilerOptions.removeComments) {
                    babelOptions.comments = true;
                }

                var directory = process.cwd();
                process.chdir(project.projectFile.projectFileDirectory);
                let babelResult
                try {
                  babelResult = babel.transform(outputFile.text, babelOptions);
                }
                catch (err) {
                  console.error(err);
                }
                process.chdir(directory);
                outputFile.text = babelResult.code;

                if (babelResult.map && settings.compilerOptions.sourceMap) {
                    let additionalEmit: ts.OutputFile = {
                        name: sourceMapFileName,
                        text: JSON.stringify(babelResult.map),
                        writeByteOrderMark: settings.compilerOptions.emitBOM
                    };

                    if (additionalEmit.name === "") {
                        // can't emit a blank file name - this should only be reached if the TypeScript
                        // language service returns the .js file before the .js.map file.
                        console.warn(`The TypeScript language service did not yet provide a .js.map name for file ${outputFile.name}`);
                        return [];
                    }

                    return [additionalEmit];
                }

                return [];
            });
        }
    }
    function getJSMapNameForJSFile(jsFileName: string) {
        for (let jsMapName in sourceMapContents) {
            if (sourceMapContents.hasOwnProperty(jsMapName)) {
                if (sourceMapContents[jsMapName].jsFileName === jsFileName) {
                    return jsMapName;
                }
            }
        }
        return "";
    }

}


function isJSFile(fileName: string) {
    return (path.extname(fileName).toLocaleLowerCase() === ".js");
}

function isJSSourceMapFile(fileName: string) {
    let lastExt = path.extname(fileName);
    if (lastExt === ".map") {
        return isJSFile(fileName.substr(0, fileName.length - 4));
    }
    return false;
}


import dts = require("../../tsconfig/dts-generator");

export function emitDts(proj: project.Project) {

    if (!proj.projectFile.project) return;
    if (proj.projectFile.project.compilerOptions.out) return;
    if (!proj.projectFile.project.package) return;
    if (!proj.projectFile.project.package.directory) return;
    if (!proj.projectFile.project.package.definition) return;

    // Determined from package.json typescript.definition property
    var outFile = path.resolve(proj.projectFile.project.package.directory, './', proj.projectFile.project.package.definition)

    // This is package.json directory
    var baseDir = proj.projectFile.project.package.directory;

    // The name of the package (of course!)
    var name = proj.projectFile.project.package.name;

    // The main file
    var main: string = proj.projectFile.project.package.main;

    // We need to find a ts file for this `main` and we also need to get its
    if (main) {
        // if path is relative we need to replace that section with 'name'
        // ./foo => 'something/foo'
        main = name + '/' + consistentPath(main.replace('./', ''));

        // Replace trailing `.js` with nothing
        main = main.replace(/\.*.js$/g, '');
    }

    // Typings become externs
    // And these are relative to the output .d.ts we are generating
    var externs = proj.projectFile.project.typings;

    // The files
    var files = proj.projectFile.project.files;

    dts.generate({
        baseDir,
        files,
        externs,
        name: name,

        target: proj.projectFile.project.compilerOptions.target,
        out: outFile,

        main: main,

        outDir: proj.projectFile.project.compilerOptions.outDir
    })
}
