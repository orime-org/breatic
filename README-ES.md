<h1 align="center">Breatic</h1>

<p align="center"><strong>El espacio de trabajo colaborativo con IA, en tiempo real, para equipos creativos.</strong></p>
<p align="center">Disponible en línea · Código disponible · Navegador de escritorio</p>

<p align="center">
  <a href="https://breatic.ai/?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=repository_listing_202610&amp;utm_content=readme_website_es">Sitio web</a> ·
  <a href="https://breatic.ai/login?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=repository_listing_202610&amp;utm_content=readme_es">Probar Breatic</a> ·
  <a href="https://youtu.be/mc1XAqtJD_M">Demo de 45 s (inglés)</a> ·
  <a href="docs/USAGE.md">Guía (inglés)</a> ·
  <a href="https://discord.gg/Yeu6A4aejN">Discord</a>
</p>

<p align="center">
  <a href="https://github.com/orime-org/breatic/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/orime-org/breatic?style=flat&amp;color=blueviolet&amp;label=release&amp;display_name=tag"></a>
  <a href="LICENSE"><img alt="License: Elastic-2.0" src="https://img.shields.io/badge/license-Elastic--2.0-blue?style=flat"></a>
  <a href="https://discord.gg/Yeu6A4aejN"><img alt="Discord community" src="https://img.shields.io/badge/discord-join%20community-5865F2?style=flat&amp;logo=discord&amp;logoColor=white"></a>
  <a href="#get-started"><img alt="Quickstart guide" src="https://img.shields.io/badge/quickstart-guide-green?style=flat"></a>
</p>

<p align="center" dir="ltr">
  <a href="README.md">English</a> · <a href="README-CN.md">简体中文</a> · <a href="README-TW.md">繁體中文</a> · <a href="README-JA.md">日本語</a> · <a href="README-KO.md">한국어</a> · <strong>Español</strong> · <a href="README-PT-BR.md">Português</a><br>
  <a href="README-DE.md">Deutsch</a> · <a href="README-FR.md">Français</a> · <a href="README-AR.md">العربية</a> · <a href="README-RU.md">Русский</a> · <a href="README-UK.md">Українська</a> · <a href="README-TR.md">Türkçe</a> · <a href="README-TH.md">ภาษาไทย</a>
</p>

---

Reúne el brief, las escenas y los archivos multimedia en un mismo Project. Escribe en Document Spaces, genera y ajusta recursos en Canvas Spaces y trabaja con un agente de IA y tus colaboradores sin perder el contexto de la producción.

El servicio alojado ofrece un plan Starter gratuito. Los créditos de generación con IA se compran por separado y no están incluidos en las suscripciones. Consulta los [precios y créditos][hosted-pricing].

![Imágenes de una cafetería en el lienzo de Breatic junto al chat del proyecto; interfaz en inglés](docs/images/readme/workspace-en.png)

## Qué puedes hacer

| Función | Para qué sirve |
| --- | --- |
| **Projects con varios Spaces** | Organiza el brief, las escenas y las alternativas creativas en pestañas separadas. |
| **Document Spaces** | Escribe guiones, descripciones de planos y listas de producción con texto formateado. |
| **Canvas Spaces** | Ordena referencias y archivos en un lienzo infinito; genera y ajusta recursos con instrucciones, modelos y referencias. |
| **3D (DEV)** | Coloca objetos incorporados en una escena compartida y modifica su posición, rotación y escala. |
| **Timeline (DEV)** | Añade vídeos del Project o sube vídeos locales a una pista visual compartida, ajusta el fotograma inicial y previsualiza la secuencia. |
| **Agente de IA en el proyecto** | Comenta ideas, aporta contexto de los documentos o del lienzo y revisa sus propuestas junto a tus materiales. |
| **Colaboración en tiempo real** | Invita a colaboradores, establece permisos y trabaja en lienzos, documentos, escenas 3D y Timelines sincronizados. |

Los recursos pueden ser imágenes, vídeos, audio y archivos 3D. La generación depende de los proveedores configurados y del acceso a sus modelos. Canvas y Document están disponibles; 3D y Timeline llevan la etiqueta **DEV**. Timeline permite organizar y previsualizar vídeos en una sola pista visual. La edición multipista, otros tipos de medios, Web Animation y la exportación de vídeo están previstas. La generación con modelos y las anotaciones dentro de la escena 3D están en desarrollo.

## Revisar los cambios juntos

Mantén las decisiones junto al trabajo. Un colaborador puede editar la dirección compartida mientras el equipo compara dos imágenes de escena. El agente puede proponer una reescritura antes de sustituir un pasaje del documento: el equipo decide qué conservar.

![Dirección compartida junto a dos imágenes de escena; interfaz en inglés](docs/images/readme/shared-direction.png)

![Propuesta de reescritura con acciones para comentar o sustituir; interfaz en inglés](docs/images/readme/agent-review.png)

Las capturas proceden de un proyecto de ejemplo real; la historia y los recursos ilustran el funcionamiento.

## Un flujo creativo: un vídeo de cafetería de 30 segundos

Un **Studio** contiene proyectos y recursos. Un **Project** reúne una producción; sus **Spaces** separan el trabajo por escena, entrega o dirección creativa.

1. **Escribe el brief** en un Document Space: historia, público, diálogo y dirección visual.
2. **Trabaja con el agente:** añade el contexto pertinente al chat, comenta los planos y revisa sus propuestas.
3. **Desarrolla cada escena** en un Canvas Space: elige un modelo configurado, aporta instrucciones y referencias, y compara las variaciones.
4. **Revisa y entrega:** selecciona los recursos con tus colaboradores y descárgalos para la producción.

Puedes llamar a los Spaces «Apertura · 0–10 s», «Escena principal · 10–20 s» y «Final · 20–30 s». Esos nombres sirven para planificar; no fijan duraciones ni montan automáticamente el vídeo. Usa Timeline para organizar y previsualizar los vídeos, y tu editor de vídeo para terminar y exportar. Consulta el [ejemplo ilustrado (inglés)](docs/USAGE.md#example-from-a-brief-to-a-visual).

<a id="get-started"></a>

## Primeros pasos

- **Producto alojado:** [abre Breatic][hosted-app] en un navegador de escritorio y regístrate o inicia sesión.
- **Tu propia instalación:** sigue la [guía de despliegue personal y en LAN (inglés)](self-host/LOCAL.md).
- **Desarrollo:** consulta la [configuración del entorno (inglés)](self-host/DEVELOPMENT.md).

Configura tu Studio personal, crea un Project y usa **+** para añadir Document, Canvas, 3D o Timeline Spaces. Empieza con un brief, sube referencias o coloca objetos 3D incorporados. La [guía de uso (inglés)](docs/USAGE.md) incluye los [atajos de teclado](docs/USAGE.md#keyboard-shortcuts).

### Antes de alojarlo por tu cuenta

La instalación utiliza imágenes Docker publicadas para la web, la API, las tareas en segundo plano y la colaboración, con PostgreSQL y Redis. Las cargas y el procesamiento multimedia requieren un Ingest Worker y un contenedor multimedia en **tu cuenta de Cloudflare**, con almacenamiento en tu bucket R2. Las llamadas de IA utilizan tus cuentas de proveedores y sus cuotas.

No es una instalación sin conexión ni completamente local. El acceso por LAN requiere HTTPS de confianza. Los servicios en la nube y las llamadas a modelos pueden generar gastos; SMTP, el inicio de sesión con Google, los pagos con Stripe y la búsqueda son integraciones opcionales. Sigue la guía para configurar y comprobar la nube. El paso inicial con Node/pnpm/Wrangler es de despliegue, no un servidor de desarrollo necesario para el uso diario.

## Estado, ayuda y contribuciones

El servicio alojado está disponible y el desarrollo continúa; siguen vigentes las etiquetas DEV y los límites descritos. Consulta las [versiones publicadas](https://github.com/orime-org/breatic/releases).

[Informar de un error](https://github.com/orime-org/breatic/issues/new?template=bug_report.yml) · [Proponer una función](https://github.com/orime-org/breatic/issues/new?template=feature_request.yml) · [Discord](https://discord.gg/Yeu6A4aejN)

Para vulnerabilidades, utiliza el canal privado de [SECURITY.md](SECURITY.md). El proyecto utiliza TypeScript, React/Vite, Hono, PostgreSQL, Redis/BullMQ y Hocuspocus/Yjs, además de un Cloudflare Worker para las cargas.

[Contribuir](CONTRIBUTING.md) · [Arquitectura](docs/ARCHITECTURE.md) · [Pruebas](docs/TEST-MANDATE.md)

[Web](https://breatic.ai) · [X](https://x.com/breatic_ai) · [YouTube](https://www.youtube.com/@breatic_ai) · [Instagram](https://www.instagram.com/breatic_ai)

## Licencia y usos permitidos

El código fuente de Breatic está disponible bajo la [Elastic License 2.0](LICENSE) (Elastic-2.0). Puedes leerlo, modificarlo, redistribuirlo y ejecutarlo para ti o dentro de tu organización, incluido el trabajo comercial. No puedes ofrecer Breatic a terceros como servicio alojado o gestionado. Consulta los términos completos en la licencia.

El nombre y el logotipo son marcas de Orime, Inc. y no están cubiertos por esta licencia; consulta [TRADEMARKS.md](TRADEMARKS.md). La licencia no restringe el contenido que creas con Breatic.

### Contenido generado

Los operadores y usuarios de cada instancia son responsables de cumplir las leyes aplicables —incluidos derechos de autor, marcas, privacidad, protección de datos, difamación y moderación—, de contar con los derechos sobre sus entradas y usos posteriores, y de moderar el contenido según su contexto. Orime, Inc. no garantiza la exactitud, legalidad, originalidad ni seguridad del contenido generado.

Los componentes de terceros y sus avisos se detallan en [THIRD-PARTY.md](THIRD-PARTY.md).

[hosted-app]: https://breatic.ai/login?utm_source=github&utm_medium=referral&utm_campaign=repository_listing_202610&utm_content=readme_es
[hosted-pricing]: https://breatic.ai/pricing/?utm_source=github&utm_medium=referral&utm_campaign=repository_listing_202610&utm_content=readme_pricing_es

© 2026 Orime, Inc.
