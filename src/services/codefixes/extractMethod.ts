/* @internal */
namespace ts.codefix.extractMethod {
    export enum RangeFacts {
        None = 0,
        HasReturn = 1 << 0,
        IsGenerator = 1 << 1,
        IsAsyncFunction = 1 << 2
    }
    export interface RangeToExtract {
        range: Expression | Statement[];
        facts: RangeFacts;

    } 
    export type Scope = FunctionLikeDeclaration | SourceFile | ModuleBlock | ClassDeclaration | ClassExpression;
    export interface ExtractResultForScope {
        readonly scope: Scope;
        readonly changes: FileTextChanges[];
    }

    export function getRangeToExtract(sourceFile: SourceFile, span: TextSpan): RangeToExtract | undefined {
        const start = getParentNodeInSpan(getTokenAtPosition(sourceFile, span.start), sourceFile, span);
        const end = getParentNodeInSpan(findTokenOnLeftOfPosition(sourceFile, textSpanEnd(span)), sourceFile, span);

        let facts = RangeFacts.None;

        if (!start || !end || start.parent !== end.parent) {
            return undefined;
        }
        if (start !== end) {
            // start and end should be statements and parent should be either block or a source file
            if (!isBlockLike(start.parent)) {
                return undefined;
            }
            if (!(isStatement(start) || isExpression(start)) && !(isStatement(end) || isExpression(end))) {
                return undefined;
            }
            const statements: Statement[] = [];
            for (const n of (<BlockLike>start.parent).statements) {
                if (n === start || statements.length) {
                    if (!checkNode(n)) {
                        return undefined;
                    }
                    statements.push(n);
                }
                if (n === end) {
                    break;
                }
            }
            return { range: statements, facts };
        }
        else {
            if (!checkNode(start)) {
                return undefined;
            }
            return isStatement(start)
                ? { range: [start], facts }
                : isExpression(start)
                    ? { range: start, facts }
                    : undefined;
        }

        function checkNode(n: Node): boolean {
            const enum PermittedJumps {
                None = 0,
                Break = 1 << 0,
                Continue = 1 << 1,
                Return = 1 << 2
            }

            let canExtract = true;
            let permittedJumps = PermittedJumps.Return;
            let seenLabels: string[];
            visit(n);
            return canExtract;

            function visit(n: Node) {
                if (!canExtract) {
                    return true;
                }
                if (!n || isFunctionLike(n) || isClassLike(n)) {
                    return;
                }
                const savedPermittedJumps = permittedJumps;
                if (n.parent) {
                    switch (n.parent.kind) {
                        case SyntaxKind.IfStatement:
                            if ((<IfStatement>n.parent).thenStatement === n || (<IfStatement>n.parent).elseStatement === n) {
                                // forbid all jumps inside thenStatement or elseStatement 
                                permittedJumps = PermittedJumps.None;
                            }
                            break;
                        case SyntaxKind.TryStatement:
                            if ((<TryStatement>n.parent).tryBlock === n) {
                                // forbid all jumps inside try blocks
                                permittedJumps = PermittedJumps.None;
                            }
                            else if ((<TryStatement>n.parent).finallyBlock === n) {
                                // allow unconditional returns from finally blocks
                                permittedJumps = PermittedJumps.Return;
                            }
                            break;
                        case SyntaxKind.CatchClause:
                            if ((<CatchClause>n.parent).block === n) {
                                // forbid all jumps inside the block of catch clause
                                permittedJumps = PermittedJumps.None;
                            }
                            break;
                        case SyntaxKind.CaseClause:
                            if ((<CaseClause>n).expression !== n) {
                                // allow unlabeled break inside case clauses
                                permittedJumps |= PermittedJumps.Break;
                            }
                            break;
                        default:
                            if (isIterationStatement(n.parent, /*lookInLabeledStatements*/ false)) {
                                if ((<IterationStatement>n.parent).statement === n) {
                                    // allow unlabeled break/continue inside loops
                                    permittedJumps |= PermittedJumps.Break | PermittedJumps.Continue;
                                }
                            }
                            break;
                    }
                }
                switch (n.kind) {
                    case SyntaxKind.LabeledStatement:
                        {
                            const label = (<LabeledStatement>n).label;
                            (seenLabels || (seenLabels = [])).push(label.text);
                            forEachChild(n, visit);
                            seenLabels.pop();
                            break;
                        }
                    case SyntaxKind.BreakStatement:
                    case SyntaxKind.ContinueStatement:
                        {
                            const label = (<BreakStatement | ContinueStatement>n).label;
                            if (label) {
                                if (!contains(seenLabels, label.text)) {
                                    // attempts to jump to label that is not in range to be extracted
                                    // TODO: return a description of the problem
                                    canExtract = false;
                                }
                            }
                            else {
                                if (!(permittedJumps & (SyntaxKind.BreakStatement ? PermittedJumps.Break : PermittedJumps.Continue))) {
                                    // attempt to break or continue in a forbidden context
                                    // TODO: return a description of the problem
                                    canExtract = false;
                                }
                            }
                            break;
                        }
                    case SyntaxKind.AwaitExpression:
                        facts |= RangeFacts.IsAsyncFunction;
                        break;
                    case SyntaxKind.YieldExpression:
                        facts |= RangeFacts.IsGenerator;
                        break;
                    case SyntaxKind.ReturnStatement:
                        if (permittedJumps & PermittedJumps.Return) {
                            facts |= RangeFacts.HasReturn;
                        }
                        else {
                            // TODO: return a description of the problem
                            canExtract = false;
                        }
                        break;
                    default:
                        forEachChild(n, visit);
                        break;
                }

                permittedJumps = savedPermittedJumps;
            }
        }
    }

    export function collectEnclosingScopes(range: RangeToExtract) {
        // 2. collect enclosing scopes
        const scopes: Scope[] = [];
        let current: Node = isArray(range.range) ? firstOrUndefined(range.range) : range.range;
        while (current) {
            if (isFunctionLike(current) || isSourceFile(current) || isModuleBlock(current)) {
                scopes.push(current);
            }
            current = current.parent;
        }
        return scopes;
    }

    export function extractRange(range: RangeToExtract, sourceFile: SourceFile, context: CodeFixContext): ExtractResultForScope[] {
        const scopes = collectEnclosingScopes(range);
        const enclosingTextRange = getEnclosingTextRange(range, sourceFile);
        const { target, usagesPerScope } = collectReadsAndWrites(range, scopes, enclosingTextRange, sourceFile, context);
        context.cancellationToken.throwIfCancellationRequested();
        return usagesPerScope.map((x, i) => extractFunctionInScope(target, scopes[i], x, range, context))
    }

    export function extractFunctionInScope(node: Node, scope: Scope, usagesInScope: Map<UsageEntry>, range: RangeToExtract, context: CodeFixContext): ExtractResultForScope {
        const changeTracker = textChanges.ChangeTracker.fromCodeFixContext(context);
        // TODO: analyze types of usages and introduce type parameters
        // TODO: generate unique function name

        const functionName = createIdentifier("newFunction");
        // TODO: derive type parameters from parameter types
        const typeParameters: TypeParameterDeclaration[] = undefined;
        // TODO: use real type?
        const returnType: TypeNode = undefined;
        const parameters: ParameterDeclaration[] = [];
        const callArguments: Identifier[] = [];
        let writes: UsageEntry[];
        usagesInScope.forEach((value, key) => {
            const paramDecl = createParameter(
                /*decorators*/ undefined,
                /*modifiers*/ undefined,
                /*dotDotDotToken*/ undefined,
                /*name*/ key,
                /*questionToken*/ undefined,
                createKeywordTypeNode(SyntaxKind.AnyKeyword), // TODO: use real type
                );
            parameters.push(paramDecl);
            if (value.usage === Usage.Write) {
                (writes || (writes = [])).push(value);
            }
            callArguments.push(createIdentifier(key));
        });

        const writesProps: ObjectLiteralElementLike[] = writes
            ? writes.map(w => createShorthandPropertyAssignment(w.symbol.name))
            : undefined;

        const { body, returnValueProperty } = transformFunctionBody(node);
        let newFunction: MethodDeclaration | FunctionDeclaration;
        if (isClassLike(scope)) {
            // always create private method
            const modifiers: Modifier[] = [createToken(SyntaxKind.PrivateKeyword)];
            if (range.facts & RangeFacts.IsAsyncFunction) {
                modifiers.push(createToken(SyntaxKind.AsyncKeyword))
            }
            newFunction = createMethod(
                /*decorators*/ undefined,
                modifiers,
                range.facts & RangeFacts.IsGenerator ? createToken(SyntaxKind.AsteriskToken) : undefined,
                functionName,
                typeParameters, 
                parameters,
                returnType,
                body
            );
        }
        else {
            newFunction = createFunctionDeclaration(
                /*decorators*/ undefined,
                range.facts & RangeFacts.IsAsyncFunction ? [createToken(SyntaxKind.AsyncKeyword)] : undefined,
                range.facts & RangeFacts.IsGenerator ? createToken(SyntaxKind.AsteriskToken) : undefined,
                functionName,
                typeParameters,
                parameters,
                returnType,
                body
            );
        }

        // insert function at the end of the scope
        changeTracker.insertNodeBefore(context.sourceFile, scope.getLastToken(), newFunction, { prefix: context.newLineCharacter, suffix: context.newLineCharacter });

        const newNodes: Node[] = [];
        // replace range with function call
        let call: Expression = createCall(
            isClassLike(scope) ? createPropertyAccess(createThis(), functionName) : functionName,
            /*typeArguments*/ undefined,
            callArguments);
        if (range.facts & RangeFacts.IsGenerator) {
            call = createYield(createToken(SyntaxKind.AsteriskToken), call);
        }
        if (range.facts & RangeFacts.IsAsyncFunction) {
            call = createAwait(call);
        }

        if (writes) {
            if (returnValueProperty) {
                // has both writes and return, need to create variable declaration to hold return value;
                newNodes.push(createVariableStatement(
                    /*modifiers*/ undefined,
                    [createVariableDeclaration(returnValueProperty, createKeywordTypeNode(SyntaxKind.AnyKeyword))]
                ));
            }
            const copy = writesProps.slice(0);
            copy.push(createShorthandPropertyAssignment(returnValueProperty));
            // propagate writes back
            newNodes.push(createStatement(createBinary(createObjectLiteral(copy), SyntaxKind.EqualsToken, call)));
            if (returnValueProperty) {
                newNodes.push(createReturn(createIdentifier(returnValueProperty)));
            }
        }
        else {
            if (range.facts & RangeFacts.HasReturn) {
                newNodes.push(createReturn(call));
            }
            else if (isArray(range.range)) {
                newNodes.push(createStatement(call));
            }
            else {
                newNodes.push(call);
            }
        }
        changeTracker.deleteNodeRange(context.sourceFile, isArray(range.range) ? range.range[0] : range.range, isArray(range.range) ? lastOrUndefined(range.range) : range.range);

        const firstNode = isArray(range.range) ? range.range[0] : range.range;
        // TODO: fix when there are no previous token (beginning of the file)
        const previousToken = findPrecedingToken(firstNode.pos, context.sourceFile);
        for (const newNode of newNodes) {
            changeTracker.insertNodeAfter(context.sourceFile, previousToken, newNode, { suffix: context.newLineCharacter });
        }
        return {
            scope,
            changes: changeTracker.getChanges() 
        };

        function transformFunctionBody(n: Node) {
            if (isBlock(n) && !writes) {
                return { body: n, returnValueProperty: undefined };
            }
            // TODO: generate unique property name
            const returnValueProperty = "__return";
            const statements = createNodeArray(isBlock(n) ? n.statements.slice(0) : [isStatement(n) ? n : createStatement(<Expression>n)]);
            if (writes) {
                let body = visitNodes(statements, visitor);
                if (body.length && lastOrUndefined(body).kind !== SyntaxKind.ReturnStatement) {
                    // add return at the end to propagate writes back in case if control flow falls out of the function body
                    body.push(createReturn(createObjectLiteral(writesProps.slice(0))))
                }
                return { body: createBlock(body), returnValueProperty }
            }
            else {
                return { body: createBlock(statements), returnValueProperty: undefined }
            }

            function visitor(n: Node): VisitResult<Node> {
                if (n.kind === SyntaxKind.ReturnStatement) {
                    const copy = writesProps.slice(0);
                    if ((<ReturnStatement>n).expression) {
                        copy.push(createPropertyAssignment(returnValueProperty, (<ReturnStatement>n).expression));
                    }
                    return createReturn(createObjectLiteral(copy));
                }
                else {
                    return visitEachChild(n, visitor, nullTransformationContext)
                }
            }
        }
    }

    const nullTransformationContext: TransformationContext = {
        enableEmitNotification: noop,
        enableSubstitution: noop,
        endLexicalEnvironment: () => undefined,
        getCompilerOptions: notImplemented,
        getEmitHost: notImplemented,
        getEmitResolver: notImplemented,
        hoistFunctionDeclaration: noop,
        hoistVariableDeclaration: noop,
        isEmitNotificationEnabled: notImplemented,
        isSubstitutionEnabled: notImplemented,
        onEmitNode: noop,
        onSubstituteNode: notImplemented,
        readEmitHelpers: notImplemented,
        requestEmitHelper: noop,
        resumeLexicalEnvironment: noop,
        startLexicalEnvironment: noop,
        suspendLexicalEnvironment: noop
    };


    function isModuleBlock(n: Node): n is ModuleBlock {
        return n.kind === SyntaxKind.ModuleBlock;
    }

    function getEnclosingTextRange(r: RangeToExtract, sourceFile: SourceFile): TextRange {
        const range = r.range;
        return isArray(range)
            ? { pos: range[0].getStart(sourceFile), end: lastOrUndefined(range).getEnd() }
            : range;
    }

    const enum Usage {
        // value should be passed to extracted method
        Read  = 1,
        // value should be passed to extracted method and propagated back
        Write = 2
    }

    interface UsageEntry {
        readonly usage: Usage;
        readonly symbol: Symbol;
    }

    function collectReadsAndWrites(
        range: RangeToExtract,
        scopes: Scope[],
        enclosingTextRange: TextRange,
        sourceFile: SourceFile,
        context: CodeFixContext) {

        context.cancellationToken.throwIfCancellationRequested();
        const checker = context.program.getTypeChecker();

        const usagesPerScope = Array<Map<UsageEntry>>(scopes.length);
        const seenUsages = createMap<Usage>();

        let valueUsage = Usage.Read;

        const target = isArray(range.range) ? createBlock(range.range) : range.range;

        forEachChild(target, collectUsages);

        return { target, usagesPerScope }

        function collectUsages(n: Node) {
            if (isAssignmentExpression(n)) {
                const savedValueUsage = valueUsage;
                valueUsage = Usage.Write;
                collectUsages(n.left);
                valueUsage = savedValueUsage;

                collectUsages(n.right);
            }
            else if (isUnaryExpressionWithWrite(n)) {
                const savedValueUsage = valueUsage;
                valueUsage = Usage.Write;
                collectUsages(n.operand);
                valueUsage = savedValueUsage;
            }
            else if (isIdentifier(n)) {
                if (!n.parent) {
                    return;
                }
                if (isQualifiedName(n.parent) && n !== n.parent.left) {
                    return;
                }
                if ((isPropertyAccessExpression(n.parent) || isElementAccessExpression(n.parent)) && n !== n.parent.expression) {
                    return ;
                }
                if (isPartOfTypeNode(n)) {
                    // TODO: check if node is accessible in scope and report an error if it is not
                }
                else {
                    recordUsage(n, valueUsage);
                }
            }
            else {
                forEachChild(n, collectUsages);
            }
        }

        function recordUsage(n: Identifier, usage: Usage) {
            // TODO: complain if generator has out flows except yielded values
            var symbol = checker.getSymbolAtLocation(n);
            if (!symbol) {
                return;
            }
            const symbolId = getSymbolId(symbol).toString();
            const lastUsage = seenUsages.get(symbolId);
            if (lastUsage && lastUsage >= usage) {
                return;
            }

            seenUsages.set(symbolId, usage);
            if (lastUsage) {
                for (const perScope of usagesPerScope) {
                    if (perScope.has(n.text)) {
                        perScope.set(n.text, { usage, symbol });
                    }
                }
                return;
            }
            // find first declaration in this file
            const declInFile = find(symbol.getDeclarations(), d => d.getSourceFile() === sourceFile);
            if (!declInFile) {
                return;
            }
            if (rangeContainsRange(enclosingTextRange, declInFile)) {
                // declaration is located in range to be extracted - do nothing
                return;
            }
            const declContainer = getEnclosingBlockScopeContainer(declInFile);
            for (let i = 0; i < scopes.length; i++) {
                const scope = scopes[i];
                // in order for declaration to be visible in scope block scope container should match or enclose the scope
                if (rangeContainsRange(declContainer, scope)) {
                    const perScope = usagesPerScope[i] || (usagesPerScope[i] = createMap<UsageEntry>());
                    perScope.set(n.text, { usage, symbol });
                }
            }
        }

        function isUnaryExpressionWithWrite(n: Node): n is PrefixUnaryExpression | PostfixUnaryExpression {
            switch (n.kind) {
                case SyntaxKind.PostfixUnaryExpression:
                    return true;
                case SyntaxKind.PrefixUnaryExpression:
                    return (<PrefixUnaryExpression>n).operator === SyntaxKind.PlusPlusToken ||
                        (<PrefixUnaryExpression>n).operator === SyntaxKind.MinusMinusToken;
                default:
                    return false;
            }
        }
    }

    function getParentNodeInSpan(n: Node, file: SourceFile, span: TextSpan): Node {
        while (n) {
            if (!n.parent) {
                return undefined;
            }
            if (isSourceFile(n.parent) || !spanContainsNode(span, n.parent, file)) {
                return n;
            }

            n = n.parent;
        }
    }

    function spanContainsNode(span: TextSpan, node: Node, file: SourceFile): boolean {
        return textSpanContainsPosition(span, node.getStart(file)) &&
            node.getEnd() <= textSpanEnd(span);
    }

    function isBlockLike(n: Node): n is BlockLike {
        switch (n.kind) {
            case SyntaxKind.Block:
            case SyntaxKind.SourceFile:
            case SyntaxKind.ModuleBlock:
            case SyntaxKind.CaseClause:
                return true;
            default:
                return false;
        }
    }
}