# Diagramas

Fuentes en [Mermaid](https://mermaid.js.org/) (GitHub los dibuja solos dentro de `docs/documento-tecnico.md`). Para exportarlos como imagen para las slides:

```powershell
npx -y @mermaid-js/mermaid-cli -i docs/diagrams/arquitectura.mmd -o docs/diagrams/arquitectura.png
```

| Archivo | Contenido |
|---|---|
| `arquitectura.mmd` | Componentes y cómo se conectan |
| `flujo-transferencia.mmd` | Secuencia de una transferencia, del cliente a Bancs |
| `modelo-datos.mmd` | Tablas principales y relaciones |
