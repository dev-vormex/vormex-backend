import swaggerUi from 'swagger-ui-express';
import { Express } from 'express';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

/**
 * Load OpenAPI spec from YAML file
 * YAML is the source of truth - no fallback to JSDoc
 */
function loadOpenAPISpec(): any {
  const yamlPath = path.join(__dirname, 'openapi.yaml');
  
  if (!fs.existsSync(yamlPath)) {
    throw new Error(
      `OpenAPI YAML file not found at ${yamlPath}. ` +
      `Please ensure src/openapi.yaml exists.`
    );
  }

  try {
    const fileContents = fs.readFileSync(yamlPath, 'utf8');
    const spec = yaml.load(fileContents) as any;
    
    // Validate that paths are defined
    if (!spec || !spec.paths || Object.keys(spec.paths).length === 0) {
      throw new Error(
        'OpenAPI spec loaded but no paths defined. ' +
        'Please check src/openapi.yaml has paths section.'
      );
    }

    console.log(`✅ Loaded OpenAPI spec with ${Object.keys(spec.paths).length} endpoints`);
    return spec;
  } catch (error) {
    console.error('❌ Failed to load OpenAPI spec from YAML:', error);
    throw new Error(
      `Failed to load OpenAPI spec: ${error instanceof Error ? error.message : String(error)}. ` +
      `Please ensure js-yaml is installed: npm install js-yaml`
    );
  }
}


/**
 * Setup Swagger UI and ReDoc
 */
export function setupSwagger(app: Express, port: string | number = process.env.PORT || 5000): void {
  const spec = loadOpenAPISpec();
  const docsBaseUrl = `http://localhost:${port}`;

  // Swagger UI
  app.use('/api-docs', swaggerUi.serve);
  app.get(
    '/api-docs',
    swaggerUi.setup(spec, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'Vormex API Documentation',
      customfavIcon: '/favicon.ico',
    })
  );

  // ReDoc alternative
  app.get('/api-docs/redoc', (_req, res) => {
    const redocHtml = `
<!DOCTYPE html>
<html>
  <head>
    <title>Vormex API - ReDoc</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
    <style>
      body {
        margin: 0;
        padding: 0;
      }
    </style>
  </head>
  <body>
    <redoc spec-url='/api-docs/swagger.json'></redoc>
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"> </script>
  </body>
</html>`;
    res.send(redocHtml);
  });

  // Serve OpenAPI spec as JSON
  app.get('/api-docs/swagger.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(spec, null, 2));
  });

  // Serve OpenAPI spec as YAML
  app.get('/api-docs/openapi.yaml', (_req, res) => {
    const specPath = path.join(__dirname, 'openapi.yaml');
    res.setHeader('Content-Type', 'text/yaml');
    res.sendFile(specPath);
  });

  console.log('📚 API Documentation available at:');
  console.log(`   - Swagger UI: ${docsBaseUrl}/api-docs`);
  console.log(`   - ReDoc: ${docsBaseUrl}/api-docs/redoc`);
  console.log(`   - OpenAPI JSON: ${docsBaseUrl}/api-docs/swagger.json`);
  console.log(`   - OpenAPI YAML: ${docsBaseUrl}/api-docs/openapi.yaml`);
}
