/**
 * 技术栈模板数据定义 — 22种技术栈的标准化规范
 * 从 tech-stack-templates.js 分离以减少单文件复杂度
 * 融合来源：DeepSeek CodeGPT X 中文开发生态（uni-app/Taro/微信小程序/鸿蒙）
 */

'use strict';

const TEMPLATE_CATEGORIES = {
  FRONTEND: 'frontend',
  BACKEND: 'backend',
  FULLSTACK: 'fullstack',
  MOBILE: 'mobile',
  SYSTEMS: 'systems',
  DATA: 'data',
  MINIPROGRAM: 'miniprogram',
  HARMONY: 'harmony',
};

const TEMPLATES = {
  react: {
    name: 'React',
    category: TEMPLATE_CATEGORIES.FRONTEND,
    version: '18.x / 19.x',
    naming: { componentFiles: 'PascalCase (.jsx/.tsx)', hookFiles: 'camelCase with use prefix (useXxx.js)', componentExports: 'Named export preferred', testFiles: '*.test.jsx or *.spec.jsx (co-located)', styleFiles: '*.module.css or *.styles.js' },
    structure: { entryPoint: 'src/index.jsx', componentDir: 'src/components/{ComponentName}/', pattern: 'ComponentName.jsx + ComponentName.test.jsx + ComponentName.module.css', hooks: 'src/hooks/useXxx.js', context: 'src/context/XxxContext.jsx' },
    comments: { componentJSDoc: 'required', propTypesOrTS: 'required (PropTypes or TypeScript interface)', effectDeps: 'explain non-obvious deps', complexHooks: 'JSDoc for custom hooks' },
    rules: { maxComponentLines: 300, maxHookLines: 100, noClassComponents: 'warn', preferFunctionalComponents: 'error', noInlineStyles: 'warn', accessibilityRequired: 'warn' },
  },

  nextjs: {
    name: 'Next.js',
    category: TEMPLATE_CATEGORIES.FULLSTACK,
    version: '14.x / 15.x (App Router)',
    naming: { pageFiles: 'page.jsx / page.tsx', layoutFiles: 'layout.jsx / layout.tsx', routeHandlers: 'route.js / route.ts', serverComponents: 'PascalCase (default)', clientComponents: "PascalCase + 'use client' directive" },
    structure: { appDir: 'app/', routes: 'app/{route}/page.jsx', apiRoutes: 'app/api/{endpoint}/route.js', components: 'components/', serverActions: 'actions/ or lib/actions/' },
    comments: { serverClientBoundary: 'explain why "use client"', fetchStrategy: 'document SSR/ISR/SSG choice', routeHandlers: 'JSDoc for each route', metadata: 'export metadata object' },
    rules: { preferServerComponents: 'error', noClientSideSecrets: 'error', cacheStrategyDocumented: 'warn', imageOptimizationRequired: 'warn' },
  },

  vue: {
    name: 'Vue.js',
    category: TEMPLATE_CATEGORIES.FRONTEND,
    version: '3.x (Composition API)',
    naming: { componentFiles: 'PascalCase (.vue)', composableFiles: 'camelCase with use prefix (useXxx.js)', componentName: 'Multi-word (vue/multi-word-component-names)', storeFiles: 'camelCase (xxxStore.js)' },
    structure: { entryPoint: 'src/main.js', components: 'src/components/', composables: 'src/composables/', stores: 'src/stores/', views: 'src/views/' },
    comments: { componentProps: 'defineProps with JSDoc', emits: 'defineEmits with JSDoc', composables: 'JSDoc for return values', provideInject: 'document injected keys' },
    rules: { componentNameMultiWord: 'error', preferCompositionAPI: 'warn', noMutatingProps: 'error', vForWithKey: 'error' },
  },

  svelte: {
    name: 'Svelte',
    category: TEMPLATE_CATEGORIES.FRONTEND,
    version: '4.x / 5.x (Runes)',
    naming: { componentFiles: 'PascalCase (.svelte)', storeFiles: 'camelCase (.svelte.js)', actionFiles: 'camelCase (.js)' },
    structure: { lib: 'src/lib/', components: 'src/lib/components/', stores: 'src/lib/stores/', routes: 'src/routes/' },
    comments: { reactiveStatements: 'explain $: derivations', storeLogic: 'document store purpose', actions: 'JSDoc for actions' },
    rules: { preferRunesV5: 'warn', noStoreMutationOutside: 'error', accessibilityRequired: 'warn' },
  },

  angular: {
    name: 'Angular',
    category: TEMPLATE_CATEGORIES.FRONTEND,
    version: '17.x / 18.x',
    naming: { componentFiles: 'kebab-case.component.ts', serviceFiles: 'kebab-case.service.ts', moduleFiles: 'kebab-case.module.ts', directiveFiles: 'kebab-case.directive.ts', pipeFiles: 'kebab-case.pipe.ts' },
    structure: { app: 'src/app/', components: 'src/app/components/', services: 'src/app/services/', models: 'src/app/models/', shared: 'src/app/shared/' },
    comments: { componentJSDoc: 'required for public components', serviceJSDoc: 'required for public methods', inputOutput: 'document @Input/@Output', lifecycle: 'explain complex lifecycle logic' },
    rules: { standaloneComponents: 'warn', typedForms: 'error', noAnyType: 'warn', onPush: 'warn', injectInConstructor: 'error' },
  },

  express: {
    name: 'Express.js',
    category: TEMPLATE_CATEGORIES.BACKEND,
    version: '4.x / 5.x',
    naming: { routeFiles: 'kebab-case.routes.js', middlewareFiles: 'kebab-case.middleware.js', controllerFiles: 'kebab-case.controller.js', modelFiles: 'PascalCase.model.js', serviceFiles: 'kebab-case.service.js' },
    structure: { entryPoint: 'server.js / app.js', routes: 'routes/', middleware: 'middleware/', controllers: 'controllers/', models: 'models/', services: 'services/', validators: 'validators/' },
    comments: { routeJSDoc: 'required (path, method, auth, response)', middlewareJSDoc: 'required (purpose, next behavior)', errorHandling: 'explain error strategy' },
    rules: { noSynchronousErrorHandlers: 'error', validationMiddlewareRequired: 'error', rateLimitOnAuthRoutes: 'error', sanitizeUserInput: 'error', structuredErrorResponses: 'warn' },
  },

  fastify: {
    name: 'Fastify',
    category: TEMPLATE_CATEGORIES.BACKEND,
    version: '4.x / 5.x',
    naming: { pluginFiles: 'kebab-case.plugin.js', routeFiles: 'kebab-case.routes.js', schemaFiles: 'kebab-case.schema.js', decoratorFiles: 'kebab-case.decorator.js' },
    structure: { entryPoint: 'app.js', plugins: 'plugins/', routes: 'routes/', schemas: 'schemas/', hooks: 'hooks/' },
    comments: { schemaJSDoc: 'required (JSON Schema for validation)', pluginOptions: 'document plugin options', decorators: 'document custom decorators' },
    rules: { schemaValidationRequired: 'error', asyncHandlersOnly: 'error', noBlockingHooks: 'warn', pluginEncapsulation: 'warn' },
  },

  nestjs: {
    name: 'NestJS',
    category: TEMPLATE_CATEGORIES.BACKEND,
    version: '10.x / 11.x',
    naming: { controllerFiles: 'kebab-case.controller.ts', serviceFiles: 'kebab-case.service.ts', moduleFiles: 'kebab-case.module.ts', dtoFiles: 'kebab-case.dto.ts', guardFiles: 'kebab-case.guard.ts', interceptorFiles: 'kebab-case.interceptor.ts' },
    structure: { modules: '{module}/', controller: '{module}/{name}.controller.ts', service: '{module}/{name}.service.ts', dto: '{module}/dto/', entities: '{module}/entities/' },
    comments: { controllerJSDoc: 'required (route, auth, response)', serviceJSDoc: 'required for public methods', dtoValidation: 'document validation decorators', dependencyInjection: 'document constructor injection' },
    rules: { validationPipesRequired: 'error', globalExceptionFilter: 'error', noCircularDeps: 'error', swaggerDecorators: 'warn', moduleOrganization: 'warn' },
  },

  django: {
    name: 'Django',
    category: TEMPLATE_CATEGORIES.BACKEND,
    version: '4.x / 5.x',
    naming: { appDirectories: 'snake_case', modelFiles: 'models.py', viewFiles: 'views.py', urlFiles: 'urls.py', serializerFiles: 'serializers.py', testFiles: 'test_*.py or tests.py' },
    structure: { project: '{project_name}/', apps: '{app_name}/', models: '{app}/models.py', views: '{app}/views.py', templates: '{app}/templates/{app}/', static: '{app}/static/{app}/' },
    comments: { modelDocstring: 'required (fields, relations, methods)', viewDocstring: 'required (HTTP methods, permissions)', serializerDocstring: 'required for DRF serializers', complexQuery: 'explain ORM queries' },
    rules: { noNPlusOneQueries: 'error', migrationRequired: 'error', csrfProtected: 'error', classBasedViews: 'warn', settingsModule: 'warn' },
  },

  flask: {
    name: 'Flask',
    category: TEMPLATE_CATEGORIES.BACKEND,
    version: '2.x / 3.x',
    naming: { blueprints: 'kebab_case.py', routeFiles: 'routes.py', modelFiles: 'models.py', formFiles: 'forms.py', templateFiles: 'kebab-case.html' },
    structure: { app: 'app/', blueprints: 'app/{blueprint}/', models: 'app/models.py', templates: 'app/templates/', static: 'app/static/' },
    comments: { routeDocstring: 'required (endpoint, methods, auth)', modelDocstring: 'required (columns, relationships)', configDocstring: 'document config keys' },
    rules: { noDebugInProduction: 'error', secretKeyRequired: 'error', sqlalchemySessionManagement: 'error', formValidationRequired: 'error' },
  },

  remix: {
    name: 'Remix',
    category: TEMPLATE_CATEGORIES.FULLSTACK,
    version: '2.x',
    naming: { loaderFiles: 'route files with loader() export', actionFiles: 'route files with action() export', componentFiles: 'PascalCase (.tsx)' },
    structure: { routes: 'app/routes/', components: 'app/components/', utils: 'app/utils/', styles: 'app/styles/' },
    comments: { loaderJSDoc: 'required (data fetched, cache strategy)', actionJSDoc: 'required (form handler, mutation)', errorBoundary: 'required for each route' },
    rules: { loaderTypeSafety: 'error', noClientSecrets: 'error', progressiveEnhancement: 'warn', metaExports: 'warn' },
  },

  reactNative: {
    name: 'React Native',
    category: TEMPLATE_CATEGORIES.MOBILE,
    version: '0.74+',
    naming: { componentFiles: 'PascalCase (.tsx)', screenFiles: 'PascalCaseScreen.tsx', navigationFiles: 'kebab-case.navigation.tsx', hookFiles: 'camelCase with use prefix' },
    structure: { screens: 'src/screens/', components: 'src/components/', navigation: 'src/navigation/', hooks: 'src/hooks/', services: 'src/services/' },
    comments: { componentJSDoc: 'required', navigationJSDoc: 'document route params', platformSpecific: 'explain iOS/Android differences' },
    rules: { noInlineStyles: 'warn', platformCheckRequired: 'error', keyboardAvoiding: 'warn', performanceOptimizedLists: 'error' },
  },

  flutter: {
    name: 'Flutter',
    category: TEMPLATE_CATEGORIES.MOBILE,
    version: '3.x',
    naming: { widgetFiles: 'snake_case.dart', screenFiles: 'snake_case_screen.dart', serviceFiles: 'snake_case_service.dart', modelFiles: 'snake_case.dart' },
    structure: { screens: 'lib/screens/', widgets: 'lib/widgets/', models: 'lib/models/', services: 'lib/services/', utils: 'lib/utils/' },
    comments: { widgetDoc: '/// documentation for public widgets', methodDoc: '/// documentation for public methods', stateManagement: 'document state management approach' },
    rules: { constConstructors: 'error', noUnnecessaryRebuilds: 'error', widgetTreeDepth: 'warn', nullSafety: 'error' },
  },

  rust: {
    name: 'Rust',
    category: TEMPLATE_CATEGORIES.SYSTEMS,
    version: '1.7x+',
    naming: { sourceFiles: 'snake_case.rs', moduleFiles: 'mod.rs', testFiles: 'test.rs or #[cfg(test)] module', traitFiles: 'snake_case.rs' },
    structure: { lib: 'src/lib.rs', main: 'src/main.rs', modules: 'src/{module}/mod.rs', tests: 'tests/', benches: 'benches/' },
    comments: { pubFnDoc: '/// documentation required for pub fn', moduleDoc: '//! module-level documentation', unsafeDoc: '/// # Safety section required', errorDoc: 'document Error types' },
    rules: { noUnwrapInLib: 'error', clippyClean: 'error', unsafeBlockDocumented: 'error', deriveTraits: 'warn', noPanicInLib: 'error' },
  },

  golang: {
    name: 'Go',
    category: TEMPLATE_CATEGORIES.SYSTEMS,
    version: '1.21+',
    naming: { packageDirs: 'lowercase single word', sourceFiles: 'snake_case.go', testFiles: 'snake_case_test.go', interfaceFiles: 'interface name (e.g., reader.go)' },
    structure: { entryPoint: 'cmd/{app}/main.go', internal: 'internal/', pkg: 'pkg/', api: 'api/' },
    comments: { packageDoc: '// Package ... required', exportedDoc: '// FunctionName ... required', interfaceDoc: 'document interface contract', errorDoc: 'document sentinel errors' },
    rules: { noPanicExported: 'error', errorChecked: 'error', contextFirstParam: 'error', interfaceSegregation: 'warn', gofmtRequired: 'error' },
  },

  pythonData: {
    name: 'Python (Data/ML)',
    category: TEMPLATE_CATEGORIES.DATA,
    version: '3.10+',
    naming: { scriptFiles: 'snake_case.py', notebookFiles: 'kebab-case.ipynb', pipelineFiles: 'snake_case_pipeline.py', modelFiles: 'snake_case_model.py' },
    structure: { data: 'data/', notebooks: 'notebooks/', src: 'src/', models: 'models/', config: 'config/' },
    comments: { functionDoc: 'NumPy-style docstring required', notebookMarkdown: 'markdown cell per section', pipelineDoc: 'document DAG structure', configDoc: 'document all config keys' },
    rules: { typeHintsRequired: 'warn', noHardcodedPaths: 'error', reproducibleSeed: 'error', memoryOptimized: 'warn' },
  },

  astro: {
    name: 'Astro',
    category: TEMPLATE_CATEGORIES.FRONTEND,
    version: '4.x / 5.x',
    naming: { pageFiles: 'kebab-case.astro', componentFiles: 'PascalCase.astro', layoutFiles: 'PascalCaseLayout.astro', islandFiles: 'PascalCase.jsx/.tsx/.vue' },
    structure: { pages: 'src/pages/', components: 'src/components/', layouts: 'src/layouts/', content: 'src/content/' },
    comments: { islandDirective: 'document client:load/visible/idle', contentCollection: 'document schema', layoutJSDoc: 'required for layouts' },
    rules: { preferStaticOutput: 'warn', noClientSideSecrets: 'error', imageOptimization: 'warn', contentCollectionSchema: 'warn' },
  },

  // ===== 融合来源：DeepSeek CodeGPT X 中文开发生态 =====

  uniapp: {
    name: 'uni-app',
    category: TEMPLATE_CATEGORIES.MINIPROGRAM,
    version: '3.x (Vue 3)',
    naming: { pageFiles: 'kebab-case.vue', componentFiles: 'PascalCase.vue', apiFiles: 'camelCase.js', storeFiles: 'camelCase (xxxStore.js)' },
    structure: { pages: 'pages/', components: 'components/', api: 'api/', store: 'store/', static: 'static/', utils: 'utils/' },
    comments: { pageConfig: 'document page config in pages.json', apiFunction: 'JSDoc with @param and @returns', componentProps: 'defineProps with JSDoc', platformCondition: 'document #ifdef platform branches' },
    rules: { conditionalCompileRequired: 'warn', noNativeDOM: 'error', rpxUnitPreferred: 'warn', apiPromiseWrap: 'warn' },
  },

  taro: {
    name: 'Taro',
    category: TEMPLATE_CATEGORIES.MINIPROGRAM,
    version: '4.x (React/Vue)',
    naming: { pageFiles: 'PascalCase.jsx/.tsx', componentFiles: 'PascalCase.jsx/.tsx', serviceFiles: 'camelCase.ts', styleFiles: '*.module.scss' },
    structure: { src: 'src/', pages: 'src/pages/', components: 'src/components/', services: 'src/services/', store: 'src/store/', utils: 'src/utils/' },
    comments: { pageConfig: 'document page config in app.config.ts', crossPlatform: 'document platform-specific logic', apiFunction: 'JSDoc with @param and @returns', hooksUsage: 'document custom hooks behavior' },
    rules: { noReactDOM: 'error', crossPlatformAPI: 'warn', taroImportRequired: 'error', cssUnitRpx: 'warn' },
  },

  wechatMiniprogram: {
    name: '微信小程序 (WeChat Mini Program)',
    category: TEMPLATE_CATEGORIES.MINIPROGRAM,
    version: '基础库 3.x',
    naming: { pageFiles: 'kebab-case (4文件: .wxml/.wxss/.js/.json)', componentFiles: 'kebab-case (4文件)', utilFiles: 'camelCase.js', cloudFiles: 'camelCase.js' },
    structure: { pages: 'pages/', components: 'components/', utils: 'utils/', cloud: 'cloud/', miniprogram: 'miniprogram/' },
    comments: { pageLifecycle: 'document onLoad/onShow/onHide lifecycle', componentProperties: 'document properties and data', apiCall: 'document wx.* API usage and error handling', cloudFunction: 'document cloud function input/output' },
    rules: { noDOMAccess: 'error', wxAPIOnly: 'error', promiseWrap: 'warn', subpackageRequired: 'warn' },
  },

  harmony: {
    name: '鸿蒙 (HarmonyOS / ArkTS)',
    category: TEMPLATE_CATEGORIES.HARMONY,
    version: 'API 12+',
    naming: { pageFiles: 'PascalCase.ets', componentFiles: 'PascalCase.ets', modelFiles: 'camelCase.ets', utilFiles: 'camelCase.ets' },
    structure: { entry: 'entry/src/main/ets/', pages: 'entry/src/main/ets/pages/', components: 'entry/src/main/ets/components/', model: 'entry/src/main/ets/model/', utils: 'entry/src/main/ets/utils/' },
    comments: { componentDoc: '/// documentation for custom components', stateManagement: 'document @State/@Prop/@Link usage', lifecycle: 'document aboutToAppear/aboutToDisappear', builderDoc: 'document @Builder functions' },
    rules: { arkTSCompliant: 'error', noTypeAny: 'error', stateDecoratorRequired: 'error', resourceAccessPattern: 'warn' },
  },
};

module.exports = { TEMPLATES, TEMPLATE_CATEGORIES };
