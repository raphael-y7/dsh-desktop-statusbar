<h1 align="center">dsh-desktop-statusbar</h1>

<p align="center">
  <a href="https://github.com/raphael-y7/dsh-desktop-statusbar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/raphael-y7/dsh-desktop-statusbar?style=flat&logo=github&color=f5f5f5"></a>
  <a href="https://www.npmjs.com/package/dsh-desktop-statusbar"><img alt="npm downloads" src="https://img.shields.io/npm/dt/dsh-desktop-statusbar?style=flat&logo=npm&label=downloads&color=e74c3c"></a>
  <a href="https://www.npmjs.com/package/dsh-desktop-statusbar"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-desktop-statusbar?style=flat&color=9B59B6"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/github/v/tag/deepseek-ai/deepseek-harness?label=DeepSeek%20Harness&color=4d6bfe"></a>
  <a href="https://awesome-dsh-plugin.com/p/raphael-y7/dsh-desktop-statusbar/"><img alt="dshmarket" src="https://img.shields.io/badge/dshmarket-listed-%23e6b800?style=flat"></a>
  <a href="https://dshfind.com/zh/plugins/raphael-y7/dsh-desktop-statusbar"><img alt="dshfind" src="https://img.shields.io/badge/dshfind-listed-%2300897B?style=flat"></a>
  <a href="https://deepseek1024.com/plugins/Rapheal-Y7/dsh-desktop-statusbar"><img alt="1024Store" src="https://img.shields.io/badge/1024Store-listed-%23e67e22?style=flat"></a>
  <br>
  <a href="https://nodejs.org/"><img alt="node" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-%230099cc?style=flat"></a>
  <img alt="language" src="https://img.shields.io/badge/javascript-100%25-%23ec407a?style=flat">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-%2327ae60?style=flat"></a>
</p>

<p align="center"><a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <a href="README.ja.md">日本語</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.ru.md">Русский</a> | <a href="README.pt.md">Português</a></p>

Reemplaza la línea de estadísticas bajo el campo de entrada de mensajes de la aplicación de escritorio DSH por una barra de estado configurable: los campos, el orden, los precios por modelo y la moneda son configurables, con estimaciones de coste en tiempo real según las tarifas oficiales de hora punta y valle de DeepSeek.

https://github.com/user-attachments/assets/5a4f7fd8-a445-490d-a557-1ec840c611df

## Características

- **9 campos opcionales más el anillo de contexto**: ocupación del contexto (el anillo al inicio de la barra), comprobación de punta/valle, turnos y pasos, tasa de acierto de caché, velocidad de salida, TTFT, tiempo de ejecución, coste de este turno, coste de la sesión, saldo
- **Haz clic en un campo para ver los detalles**:

  | Campo | Contenido |
  | --- | --- |
  | Anillo de contexto (inicio de la barra) | Indicación del sistema / definiciones de herramientas / mensajes |
  | Comprobación punta/valle | Mapa de calor de uso: día / semana / mes / año |
  | Turnos y pasos | Compactaciones de contexto / habilidades inyectadas / llamadas a herramientas |
  | Acierto combinado | Tasa de acierto de caché de este turno / la más alta / la más baja |
  | TPS | Velocidad de este turno / la más rápida / la más lenta |
  | TTFT | Retardo del primer token de este turno / el más rápido / el más lento |
  | Tiempo de ejecución | Tiempo de espera / tiempo de modelo / llamadas a herramientas |
  | Coste de este turno | Desglose de tokens de este turno |
  | Coste de la sesión | Desglose acumulado de tokens de esta sesión |
  | Saldo | Saldo recargado / saldo concedido / cuota restante |

- **Exploración de datos de sesión**: las compactaciones de contexto marcan el nodo donde ocurrieron, las habilidades inyectadas cuentan las habilidades inyectadas en esta sesión y las llamadas a herramientas enumeran cada herramienta usada por la sesión con su número de llamadas; haz clic en el título para volver arriba
- **Comprobación y actualización de versión**: DSH busca la última versión al iniciarse, muestra una pista junto al elemento de navegación «Barra de estado» cuando hay una disponible y ofrece un botón de actualización con un clic en los ajustes
- **Apoyo en GitHub**: el botón abre la página del proyecto en GitHub, donde puedes dar una estrella al proyecto.
- **Estimación de costes**: con precios según las reglas oficiales de hora punta y valle; cada llamada se calcula desde el momento en que ocurrió y el modelo que utilizó
- **Lista de precios**: tus propios precios, un desglose opcional de punta/valle y un selector de moneda CNY / USD
- **También**: actualizaciones automáticas de festivos, saldo actualizado cada minuto, 8 idiomas de interfaz (chino simplificado / English / 日本語 / Español / Français / Deutsch / Русский / Português)

## Instalación

En la aplicación de escritorio DSH, abre **Complementos → Añadir complemento** e instala por nombre de paquete:

```
dsh-desktop-statusbar
```

Cuando el registro npm no es accesible, el mismo cuadro de diálogo ofrece el espejo de China continental como fuente de instalación. También se acepta una URL de repositorio de GitHub:

```
https://github.com/raphael-y7/dsh-desktop-statusbar
```

Línea de comandos:

```powershell
dsh plugin --profile desktop add dsh-desktop-statusbar
```

### Instalar desde npm

Ambas formas anteriores instalan desde el registro npm; el nombre del paquete es `dsh-desktop-statusbar`. Para consultar la versión actual en npm:

```powershell
npm view dsh-desktop-statusbar version
```

### Cuando falla el actualizador integrado

El botón de actualización integrado con un clic puede fallar en algunas compilaciones de escritorio, sin responder o informando de un error. En ese caso, usa la entrada oficial de instalación y **añade `@version` al nombre del paquete** para instalar la versión exacta:

```powershell
dsh plugin --profile desktop add dsh-desktop-statusbar@3.0.5
```

La misma cadena funciona en el panel de complementos: escribe `dsh-desktop-statusbar@3.0.5` en el campo **Añadir complemento**.

Usa la versión más reciente actual (la que se muestra en la página de lanzamiento o en la salida de `npm view` anterior). Fijar la versión también garantiza que **instalas exactamente la compilación objetivo**, evitando un paquete en caché obsoleto.

También aparece en [dshmarket](https://awesome-dsh-plugin.com/p/raphael-y7/dsh-desktop-statusbar/), [dshfind](https://dshfind.com/zh/plugins/raphael-y7/dsh-desktop-statusbar) y [1024Store](https://deepseek1024.com/plugins/Rapheal-Y7/dsh-desktop-statusbar).

## Uso

Abre **Ajustes → Barra de estado**:

![Settings page](docs/settings.en.png)

- **Ocupación del contexto**: el anillo al inicio de la barra: el progreso muestra la proporción de contexto usado, el hueco marca el umbral de compactación y el color muestra el estado de ejecución (inactivo-gris / en ejecución-verde / subagente en ejecución-azul / subagente más profundo en ejecución-violeta / error-rojo / pendiente de aprobación-ámbar)
- **Campos de estadísticas**: las casillas solo controlan la visibilidad, así que desmarcar oculta un campo sin moverlo; arrastra el tirador de la derecha para reordenar; «Restablecer ajustes» restaura el orden de fábrica
- **Precios de modelo personalizados**: introduce un nombre de modelo y «Añadir» para crear una entrada; «Editar» abre el editor y los cambios se escriben al guardar; marca «precios punta/valle» para dividir por franja horaria; de lo contrario se aplica un precio plano para todo el día
- **Moneda**: CNY o USD en la esquina superior derecha del editor. Cambiarla sustituye los dos modelos integrados por los precios de referencia oficiales de esa moneda (las entradas editadas se conservan) y cambia el símbolo en los campos de coste; el saldo sigue la moneda indicada por la API
- **Festivos**: obtiene y escribe automáticamente el calendario del próximo año después del 31 de diciembre de cada año
- **Saldo**: se actualiza una vez por minuto

### Reglas de facturación

Las horas punta son **09:00–12:00 y 14:00–18:00 hora de Pekín, de lunes a viernes**, y las tarifas de hora valle son la mitad de las de punta; los festivos públicos chinos y los fines de semana se facturan a tarifa valle todo el día (según la [documentación oficial](https://api-docs.deepseek.com/quick_start/pricing), comprobado en 2026-09).

![Custom model prices](docs/pricing.en.png)

## Consulta del saldo del relé

Al consultar un saldo, la barra de estado elige el método de consulta según **la plataforma que realmente usa la sesión actual**, en dos casos: coincidencia automática y configuración manual.

### 1. Coincidencia automática

Cuando el relé está configurado como un provider normal en la página **Modelos** de DSH (con baseURL y clave de API), el complemento usa esa clave para sondear en paralelo los siguientes puntos de conexión de saldo habituales; si responde cualquier punto de conexión analizable, el saldo se muestra sin configuración adicional:

- `/v1/usage`
- `/v1/user/self`, `/api/user/self`, `/api/v1/user/self`
- `/api/usage`
- `/v1/dashboard/billing/credit_grants`
- `/v1/credits`

Si el punto de conexión de saldo del sitio pertenece a una de las formas estándar anteriores y se puede leer mediante `Authorization: Bearer <clave de API>`, el saldo se muestra automáticamente.

### 2. Configuración manual

En cualquiera de los siguientes casos, debe añadir una entrada de plataforma en **Ajustes → Barra de estado → Precios de modelo personalizados → Plataforma** y rellenar el punto de conexión y las credenciales:

- el provider no tiene baseURL configurada en la página **Modelos**;
- el punto de conexión de saldo o el esquema de autenticación no sigue una forma estándar (por ejemplo, New API requiere una cabecera de solicitud adicional con el ID de usuario);
- la estructura de respuesta del punto de conexión no se puede analizar automáticamente.

Los campos se definen como sigue:

| Campo | Descripción | Ejemplo |
| --- | --- | --- |
| Cabecera de solicitud | Nombre de la cabecera de solicitud usada para el ID de usuario; la autenticación por token siempre usa `authorization: Bearer` y no es necesario rellenarla | `New-Api-User` |
| ID de usuario | El identificador de usuario para la cabecera de solicitud anterior | `12345` |
| Token | New API: introduzca el «token de acceso» (el token de acceso del sistema en los ajustes personales); Sub2API: introduzca el «token de inicio de sesión»; relé normal: introduzca la clave `sk-` usada para llamar a los modelos | `sk-...` |
| Dirección de consulta de saldo | URL completa del punto de conexión de saldo | `https://example.com/api/user/self` |
| Campo de saldo | Símbolo de moneda, ruta de campo y divisor, con el formato `<moneda><ruta de campo> / <divisor>` | `$data.quota / 500000` |
| Modelos aplicables | Los modelos que pertenecen a esta plataforma | — |
| Multiplicador de coste | Multiplicador de tarificación, por defecto 1 | `1` |

#### Ejemplo 1: sitio compatible con New API

- Dirección de consulta de saldo: `https://example.com/api/user/self`
- Campo de saldo: `$data.quota / 500000` (este sitio cuenta 500000 de cuota como 1 yuan)
- Token: el token de acceso generado en los ajustes personales (no una clave de llamada de modelo)
- Cabecera de solicitud: `New-Api-User`; ID de usuario: el ID de usuario de la cuenta

#### Ejemplo 2: sitio Sub2API

El punto de conexión de saldo de los sitios Sub2API suele presentar una de las dos formas siguientes; elija según la situación real del sitio:

- Admite `GET /v1/usage` compatible con OpenAI (autenticación con la clave de modelo `sk-`): por lo general se empareja automáticamente, sin configuración manual; si no hay coincidencia, introduzca esa clave `sk-` como token y `https://example.com/v1/usage` como dirección de consulta de saldo.
- Solo está disponible un punto de conexión de consola (el punto de conexión está en `/api/v1/*` y requiere una sesión de inicio de sesión en la consola): introduzca como dirección de consulta de saldo el punto de conexión de saldo de la consola del sitio (según el real del sitio), **introduzca el «token de inicio de sesión» como token** (la credencial de acceso obtenida tras iniciar sesión en la consola, no una clave de llamada de modelo), y rellene el campo de saldo según la estructura de respuesta del punto de conexión.

#### Ejemplo 3: relé compatible con OpenAI de clave única

- Token: la clave `sk-` usada para llamar a los modelos
- Por lo general se empareja automáticamente; si no, añada la dirección de consulta de saldo y el campo de saldo (como `$balance` o `$data.balance`).

> Nota: si la dirección de consulta de saldo se deja vacía, no se consulta el saldo de esa plataforma, pero sigue participando en la facturación según el multiplicador de coste.

## Limitaciones conocidas

- El TTFT y la velocidad más rápidos/más lentos provienen de una nueva proyección del lado del host: **debes cerrar completamente y reiniciar DSH** antes de que empiece a recopilar
- Un modelo sin precio no se factura; al añadir el precio se rellenan retroactivamente sus llamadas anteriores
- La actualización con un clic depende de `pnpm`: la aplicación de escritorio usa la copia incluida con el host, mientras que el uso por CLI / web necesita `pnpm` en el sistema. Si no se encuentra ninguno, la actualización lo indica explícitamente **y registra en el log todas las ubicaciones que probó**; también puedes apuntarla a un comando concreto con la variable de entorno `DSH_DESKTOP_STATUSBAR_PNPM`

## Permisos y acceso externo

El complemento lee los registros de sesión y la configuración local para calcular el uso, el saldo y el coste, y admite la autoactualización con un clic, por lo que es un **complemento de altos privilegios**. A continuación se muestra el límite real de permisos (coincidente con el código de `lib/`). Revísalo antes de instalar.

### Archivos

| Ruta | Propósito | Notas |
| --- | --- | --- |
| <DSH_HOME>/dsh-status-bar/usage-ledger.json | Registro local de uso, rellenado desde el historial al iniciarse | Escribe solo dentro del propio directorio del complemento |
| <DSH_HOME>/dsh-status-bar/holidays.json | Caché de días festivos | Se escribe durante las actualizaciones automáticas de festivos en segundo plano |
| <DSH_HOME>/dsh-status-bar/exchange-rate.json | Caché diaria de tipos de cambio | Se escribe al actualizar los tipos de cambio en segundo plano |
| <DSH_HOME>/dsh-status-bar/tip-diag.log | Registro de diagnóstico | Registra diagnósticos de posición de los tooltips para facilitar la solución de problemas |
| <DSH_HOME>/dsh-status-bar/relay-balance.json | Configuración de saldo del relay (sin secreto en texto plano) | Directorio del complemento |
| <DSH_HOME>/sessions | Lee los registros de sesión para calcular estadísticas de tokens / coste | Solo lectura |
| <DSH_HOME>/.credentials.yaml | Lee las claves API por refs solo cuando ni el servicio de credenciales ni las variables de entorno proporcionan una | Solo lectura |
| Profile `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` | Se respaldan y se reescriben durante la autoactualización con un clic | Solo al hacer clic en «actualización con un clic» |

### Red

Las solicitudes se hacen solo para mostrar el saldo, los tipos de cambio, los días festivos o comprobar actualizaciones; todas por HTTPS excepto el loopback local 127.0.0.1, y fallan silenciosamente al agotarse el tiempo de espera sin bloquear los demás campos de la barra de estado.

| Dominio | Propósito |
| --- | --- |
| `api.deepseek.com` | Saldo de la cuenta de DeepSeek |
| `openrouter.ai` | Créditos de OpenRouter |
| `api.siliconflow.com` / `api.siliconflow.cn` | Información de la cuenta de SiliconFlow |
| `api.moonshot.ai` / `api.moonshot.cn` | Saldo de Moonshot |
| `open.bigmodel.cn` / `api.z.ai` | Cuota de Zhipu |
| `api.b.ai` | Saldo de B.AI |
| `api.xiaomimimo.com` | Saldo de Xiaomi MiMo |
| `api.stepfun.com` / `api.stepfun.ai` | Saldo de la cuenta de StepFun (China / Internacional) |
| `www.minimax.cn` | Cuota de MiniMax Token Plan |
| `management-api.x.ai` | Saldo del equipo de xAI |
| `business.aliyuncs.com` | Saldo de la cuenta BSS de Alibaba Cloud |
| `open.er-api.com` | Tipo de cambio del CNY |
| `sousuo.www.gov.cn` | Actualización automática de días festivos |
| `registry.npmjs.org` | Comprobación de versión (autoactualización) |
| `127.0.0.1` (loopback) | Puerto web del host / adaptadores locales |

Dejar vacía la URL de saldo de una plataforma significa que no se consulta, y no afecta a la facturación.

### Credenciales

- Usa primero el servicio de credenciales del host `ctx.credentials` (la fuente autoritativa escrita por la página de modelos); si no está disponible, recurre a las variables de entorno (p. ej. `DEEPSEEK_API_KEY` y el nombre de refs de cada adaptador) y luego a la sección refs de `<DSH_HOME>/.credentials.yaml`.
- Las claves API **solo se usan para consultar el saldo de esa plataforma**; nunca se suben a otro sitio, se registran en el log ni se escriben en el registro.
- La página de ajustes muestra los tokens como puntos con seleccionar-para-copiar; `GET /dsh-desktop-statusbar/api/relay-balance-config` devuelve el token del mismo origen al frontend. Ese endpoint es solo de loopback (comprobaciones de Host / Origin / remoteAddress) y nunca sale de la máquina.

### Comandos

- `pnpm` se invoca solo al hacer clic en «actualización con un clic»: prefiere el pnpm incluido con el host (p. ej. `runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`), recurriendo al `pnpm` del sistema; puedes apuntarlo con la variable de entorno `DSH_DESKTOP_STATUSBAR_PNPM`.
- Si falla, la actualización restaura el respaldo del perfil y muestra el motivo; si no se encuentra pnpm lo informa explícitamente y registra en el log todas las ubicaciones probadas.

### Límites de fallo

- Sin credenciales: el saldo de esa plataforma muestra «—»; los demás campos siguen funcionando.
- Fallo de red / tiempo de espera: solo se ve afectado ese saldo o tipo de cambio; las demás estadísticas no se ven afectadas.
- pnpm no encontrado: la actualización con un clic da error explícitamente en lugar de fallar en silencio.
- Fallo de la autoactualización: se restaura el respaldo de `package.json` / archivo de bloqueo del perfil.

### Riesgos conocidos

- Complemento de altos privilegios (lectura/escritura de archivos + red + credenciales + comandos): decida si desea instalarlo después de comprender el alcance de los permisos.
- Cuando los servicios externos de saldo no están disponibles, las cifras relacionadas faltan o están desactualizadas.
- La autoactualización con un clic necesita acceso de escritura al directorio del perfil.

## Desarrollo

Cada prueba es un script independiente pensado para ejecutarse con node simple: sin framework de pruebas.

```powershell
npm test          # runs every verify*.js/.mjs under tests/, then checks project vs installed plugin dir
npm run sync      # copies lib/ into the installed plugin dir
```

Los scripts de desarrollo en `tools/` se incluyen con el paquete (el campo `files` los incluye),
así que tanto un clon de git como una instalación de npm los obtienen:

| Script | Propósito |
|---|---|
| `tools/test.cjs` | ejecución completa de pruebas + guardia de consistencia |
| `tools/sync-to-plugin.cjs` | `lib/` del proyecto → directorio del complemento instalado |
| `tools/sync-from-plugin.cjs` | directorio del complemento instalado → `lib/` del proyecto |
| `tools/plugin-dir.cjs` | localiza el directorio del complemento |
| `tools/shot.cjs` | regenera las capturas de pantalla del README |

Solo se usan durante el desarrollo; el complemento nunca los carga en tiempo de ejecución.
El paquete npm incluye `tests/` y `tools/`, así que una copia instalada puede ejecutar
`node tools/test.cjs` directamente (ejecución completa de pruebas + guardia de consistencia).

El directorio del complemento se localiza automáticamente: variable de entorno `DSH_STATUS_BAR_PLUGIN_DIR` →
diseños conocidos bajo `~/.dsh` (`local-plugins/`, cada `profiles/*/node_modules/`) → derivado de la
ubicación de `tools/`. No se necesitan cambios de código al cambiar de máquina o de nombre de usuario.

## Licencia

[MIT](LICENSE): libre para usar, modificar y redistribuir; conserva el aviso de copyright y licencia.
