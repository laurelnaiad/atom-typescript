var mkdirp = require('mkdirp');
var path = require('path');
var fs = require('fs');
var fsUtil_1 = require("../../utils/fsUtil");
var utils_1 = require("../utils");
var findup = require('findup');
var babels = {};
var babelConfigs = {};
exports.Not_In_Context = "/* NotInContext */";
function diagnosticToTSError(diagnostic) {
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
exports.diagnosticToTSError = diagnosticToTSError;
function emitFile(proj, filePath) {
    var services = proj.languageService;
    var output = services.getEmitOutput(filePath);
    var emitDone = !output.emitSkipped;
    var errors = [];
    var sourceFile = services.getSourceFile(filePath);
    var allDiagnostics = services.getCompilerOptionsDiagnostics()
        .concat(services.getSyntacticDiagnostics(filePath))
        .concat(services.getSemanticDiagnostics(filePath));
    allDiagnostics.forEach(function (diagnostic) {
        if (!diagnostic.file)
            return;
        var startPosition = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        errors.push(diagnosticToTSError(diagnostic));
    });
    if (!output.emitSkipped) {
        {
            var sourceMapContents = {};
            output.outputFiles.forEach(function (o) {
                mkdirp.sync(path.dirname(o.name));
                var additionalEmits = runExternalTranspilerSync(filePath, sourceFile.text, o, proj, sourceMapContents, errors);
                if (!sourceMapContents[o.name] && !proj.projectFile.project.compilerOptions.noEmit) {
                    fs.writeFileSync(o.name, o.text, "utf8");
                }
                if (additionalEmits) {
                    additionalEmits.forEach(function (a) {
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
    var outputFiles = output.outputFiles.map(function (o) { return o.name; });
    if (path.extname(filePath) == '.d.ts') {
        outputFiles.push(filePath);
    }
    return {
        sourceFileName: filePath,
        outputFiles: outputFiles,
        success: emitDone && !errors.length,
        errors: errors,
        emitError: !emitDone
    };
}
exports.emitFile = emitFile;
function getRawOutput(proj, filePath) {
    var services = proj.languageService;
    var output;
    if (proj.includesSourceFile(filePath)) {
        output = services.getEmitOutput(filePath);
    }
    else {
        output = {
            outputFiles: [{ name: filePath, text: exports.Not_In_Context, writeByteOrderMark: false }],
            emitSkipped: true
        };
    }
    return output;
}
exports.getRawOutput = getRawOutput;
function getRawOutputPostExternal(proj, filePath) {
    var services = proj.languageService;
    var output;
    if (proj.includesSourceFile(filePath)) {
        output = services.getEmitOutput(filePath);
        if (output.outputFiles.length) {
            var sourceFile = proj.languageService.getSourceFile(filePath);
            var sourceMapContents = {};
            var errs = [];
            var addionalFiles = runExternalTranspilerSync(filePath, sourceFile.text, output.outputFiles[0], proj, sourceMapContents, errs);
            if (errs.length) {
                return {
                    outputFiles: [],
                    emitSkipped: false
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
    }
    else {
        output = {
            outputFiles: [{ name: filePath, text: exports.Not_In_Context, writeByteOrderMark: false }],
            emitSkipped: true
        };
        return output;
    }
}
exports.getRawOutputPostExternal = getRawOutputPostExternal;
function getBabelInstanceSync(projectDirectory) {
    if (!babels[projectDirectory]) {
        var dir;
        dir = '/Users/dmaddox/Documents/_ws/atom-typescript/node_modules/babel-core';
        babels[projectDirectory] = require(dir);
        var babelrcDir;
        try {
            babelrcDir = findup.sync(projectDirectory, '.babelrc');
            var data = fs.readFileSync(path.join(babelrcDir, '.babelrc'));
            babelConfigs[projectDirectory] = JSON.parse(data.toString());
        }
        catch (e) { }
    }
    return babels[projectDirectory];
}
function getBabelInstance(projectDirectory) {
    return new Promise(function (resolve) {
        if (!babels[projectDirectory]) {
            findup(projectDirectory, 'node_modules/babel-core', function (err, dir) {
                if (err) {
                    findup(projectDirectory, 'node_modules/babel', function (err, dir) {
                        if (err) {
                            console.error('just require');
                            console.error(require.resolve('babel'));
                            babels[projectDirectory] = require('babel');
                        }
                        else {
                            console.error(dir);
                            babels[projectDirectory] = require(path.join(dir, 'node_modules/babel'));
                        }
                        resolve(babels[projectDirectory]);
                    });
                }
                else {
                    console.error(dir);
                    babels[projectDirectory] = require(path.join(dir, 'node_modules/babel-core'));
                    resolve(babels[projectDirectory]);
                }
            });
        }
        else {
            resolve(babels[projectDirectory]);
        }
    }).then(function (babel) {
        return new Promise(function (resolve) {
            findup(projectDirectory, '.babelrc', function (err, dir) {
                if (err)
                    return resolve(babel);
                fs.readFile(path.join(dir, '.babelrc'), function (err, data) {
                    try {
                        babelConfigs[projectDirectory] = JSON.parse(data.toString());
                    }
                    catch (e) { }
                    resolve(babel);
                });
            });
        });
    });
}
function runExternalTranspilerSync(sourceFileName, sourceFileText, outputFile, project, sourceMapContents, errors) {
    if (!isJSFile(outputFile.name) && !isJSSourceMapFile(outputFile.name)) {
        return [];
    }
    var settings = project.projectFile.project;
    var externalTranspiler = settings.externalTranspiler;
    if (!externalTranspiler) {
        return [];
    }
    if (isJSSourceMapFile(outputFile.name)) {
        var sourceMapPayload = JSON.parse(outputFile.text);
        var jsFileName = fsUtil_1.consistentPath(path.resolve(path.dirname(outputFile.name), sourceMapPayload.file));
        sourceMapContents[outputFile.name] = { jsFileName: jsFileName, sourceMapPayload: sourceMapPayload };
        return [];
    }
    if (typeof externalTranspiler === 'string') {
        externalTranspiler = {
            name: externalTranspiler,
            options: {}
        };
    }
    console.error('wtf?');
    if (typeof externalTranspiler === 'object') {
        if (externalTranspiler.name.toLocaleLowerCase() === "babel") {
            var babel = getBabelInstanceSync(project.projectFile.projectFileDirectory);
            var babelOptions = utils_1.assign(babelConfigs[project.projectFile.projectFileDirectory] || {}, externalTranspiler.options || {}, {
                filename: outputFile.name
            });
            var sourceMapFileName = getJSMapNameForJSFile(outputFile.name);
            if (sourceMapContents[sourceMapFileName]) {
                babelOptions.inputSourceMap = sourceMapContents[sourceMapFileName].sourceMapPayload;
                var baseName = path.basename(sourceFileName);
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
            var babelResult;
            try {
                var directory = process.cwd();
                process.chdir(project.projectFile.projectFileDirectory);
                babelResult = babel.transform(outputFile.text, babelOptions);
                process.chdir(directory);
                outputFile.text = babelResult.code;
            }
            catch (err) {
                console.error('err' + err.toString());
                var codeErr = {
                    filePath: outputFile.name,
                    startPos: { line: 0, col: 0 },
                    endPos: { line: 0, col: 0 },
                    message: '',
                    preview: ''
                };
                var parse1 = /^([^:]*):\s([^:]*):\s([^:]*)\s\((\d*):(\d*)\)(([\r|\r\n]*[^\r|\r\n]*)*)$/m;
                var parse2 = /^([^:]*):\s([^:]*):\s*(.*)(([\r|\r\n]|.)*)$/m;
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
                        codeErr.startPos.line = 0;
                        codeErr.startPos.col = 0;
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
                        codeErr.startPos.line = 0;
                        codeErr.startPos.col = 0;
                        codeErr.endPos.line = codeErr.startPos.line;
                        codeErr.endPos.col = codeErr.startPos.col;
                        codeErr.preview = err.toString();
                        codeErr.message = 'Unparseable Babel problem.';
                    }
                }
                errors.push(codeErr);
            }
            if (babelResult) {
                console.log('result!');
            }
            if (babelResult && babelResult.map) {
                var additionalEmit = {
                    name: sourceMapFileName,
                    text: JSON.stringify(babelResult.map),
                    writeByteOrderMark: settings.compilerOptions.emitBOM
                };
                if (additionalEmit.name === "") {
                    console.warn("The TypeScript language service did not yet provide a .js.map name for file " + outputFile.name);
                    return [];
                }
                return [additionalEmit];
            }
            else {
                return [];
            }
        }
    }
    function getJSMapNameForJSFile(jsFileName) {
        for (var jsMapName in sourceMapContents) {
            if (sourceMapContents.hasOwnProperty(jsMapName)) {
                if (sourceMapContents[jsMapName].jsFileName === jsFileName) {
                    return jsMapName;
                }
            }
        }
        return "";
    }
}
function runExternalTranspiler(sourceFileName, sourceFileText, outputFile, project, sourceMapContents) {
    console.error('runit');
    if (!isJSFile(outputFile.name) && !isJSSourceMapFile(outputFile.name)) {
        return Promise.resolve([]);
    }
    var settings = project.projectFile.project;
    var externalTranspiler = settings.externalTranspiler;
    if (!externalTranspiler) {
        return Promise.resolve([]);
    }
    if (isJSSourceMapFile(outputFile.name)) {
        var sourceMapPayload = JSON.parse(outputFile.text);
        var jsFileName = fsUtil_1.consistentPath(path.resolve(path.dirname(outputFile.name), sourceMapPayload.file));
        sourceMapContents[outputFile.name] = { jsFileName: jsFileName, sourceMapPayload: sourceMapPayload };
        return Promise.resolve([]);
    }
    if (typeof externalTranspiler === 'string') {
        externalTranspiler = {
            name: externalTranspiler,
            options: {}
        };
    }
    if (typeof externalTranspiler === 'object') {
        if (externalTranspiler.name.toLocaleLowerCase() === "babel") {
            return getBabelInstance(project.projectFile.projectFileDirectory).then(function (babel) {
                var babelOptions = utils_1.assign(babelConfigs[project.projectFile.projectFileDirectory] || {}, externalTranspiler.options || {}, {
                    filename: outputFile.name
                });
                var sourceMapFileName = getJSMapNameForJSFile(outputFile.name);
                if (sourceMapContents[sourceMapFileName]) {
                    babelOptions.inputSourceMap = sourceMapContents[sourceMapFileName].sourceMapPayload;
                    var baseName = path.basename(sourceFileName);
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
                var babelResult;
                try {
                    babelResult = babel.transform(outputFile.text, babelOptions);
                }
                catch (err) {
                    console.error(err);
                }
                process.chdir(directory);
                outputFile.text = babelResult.code;
                if (babelResult.map && settings.compilerOptions.sourceMap) {
                    var additionalEmit = {
                        name: sourceMapFileName,
                        text: JSON.stringify(babelResult.map),
                        writeByteOrderMark: settings.compilerOptions.emitBOM
                    };
                    if (additionalEmit.name === "") {
                        console.warn("The TypeScript language service did not yet provide a .js.map name for file " + outputFile.name);
                        return [];
                    }
                    return [additionalEmit];
                }
                return [];
            });
        }
    }
    function getJSMapNameForJSFile(jsFileName) {
        for (var jsMapName in sourceMapContents) {
            if (sourceMapContents.hasOwnProperty(jsMapName)) {
                if (sourceMapContents[jsMapName].jsFileName === jsFileName) {
                    return jsMapName;
                }
            }
        }
        return "";
    }
}
function isJSFile(fileName) {
    return (path.extname(fileName).toLocaleLowerCase() === ".js");
}
function isJSSourceMapFile(fileName) {
    var lastExt = path.extname(fileName);
    if (lastExt === ".map") {
        return isJSFile(fileName.substr(0, fileName.length - 4));
    }
    return false;
}
var dts = require("../../tsconfig/dts-generator");
function emitDts(proj) {
    if (!proj.projectFile.project)
        return;
    if (proj.projectFile.project.compilerOptions.out)
        return;
    if (!proj.projectFile.project.package)
        return;
    if (!proj.projectFile.project.package.directory)
        return;
    if (!proj.projectFile.project.package.definition)
        return;
    var outFile = path.resolve(proj.projectFile.project.package.directory, './', proj.projectFile.project.package.definition);
    var baseDir = proj.projectFile.project.package.directory;
    var name = proj.projectFile.project.package.name;
    var main = proj.projectFile.project.package.main;
    if (main) {
        main = name + '/' + fsUtil_1.consistentPath(main.replace('./', ''));
        main = main.replace(/\.*.js$/g, '');
    }
    var externs = proj.projectFile.project.typings;
    var files = proj.projectFile.project.files;
    dts.generate({
        baseDir: baseDir,
        files: files,
        externs: externs,
        name: name,
        target: proj.projectFile.project.compilerOptions.target,
        out: outFile,
        main: main,
        outDir: proj.projectFile.project.compilerOptions.outDir
    });
}
exports.emitDts = emitDts;
