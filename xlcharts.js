/* Adds native Excel scatter charts (DrawingML) to an .xlsx produced by ExcelJS, which cannot write charts.
 * The charts point at worksheet cells, so they stay live and editable in Excel.
 *   addCharts(JSZip, xlsxBuffer, charts) -> Promise<ArrayBuffer|Uint8Array>
 * chart = { sheet, from:{col,row}, to:{col,row} (0-based cells), title, xTitle, yTitle, xFmt,
 *           series:[{ name, kind:"points"|"line", color, xRef, yRef, xs, ys }] }
 */
(function (root) {
  "use strict";
  const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
  const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const NS_PR = "http://schemas.openxmlformats.org/package/2006/relationships";
  const REL_DRAWING = NS_R + "/drawing", REL_CHART = NS_R + "/chart";
  const CT_DRAWING = "application/vnd.openxmlformats-officedocument.drawing+xml";
  const CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  function rich(text, size, bold) {
    return '<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="' + size + '" b="' + (bold ? 1 : 0) + '"/></a:pPr>' +
      '<a:r><a:rPr lang="ko-KR" sz="' + size + '" b="' + (bold ? 1 : 0) + '"/><a:t>' + esc(text) + "</a:t></a:r></a:p></c:rich></c:tx>";
  }
  function numCache(vals, fmt) {
    let s = "<c:numCache><c:formatCode>" + esc(fmt) + '</c:formatCode><c:ptCount val="' + vals.length + '"/>';
    vals.forEach((v, i) => { if (v !== null && v !== undefined && isFinite(v)) s += '<c:pt idx="' + i + '"><c:v>' + v + "</c:v></c:pt>"; });
    return s + "</c:numCache>";
  }
  const txPr = (size) => '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="' + size + '"/></a:pPr><a:endParaRPr lang="ko-KR"/></a:p></c:txPr>';

  function chartXml(ch) {
    let ser = "";
    ch.series.forEach((s, i) => {
      const line = s.kind === "line";
      ser += '<c:ser><c:idx val="' + i + '"/><c:order val="' + i + '"/><c:tx><c:v>' + esc(s.name) + "</c:v></c:tx>" +
        (line ? '<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="' + s.color + '"/></a:solidFill><a:round/></a:ln></c:spPr>' +
                '<c:marker><c:symbol val="none"/></c:marker>'
              : '<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr>' +
                '<c:marker><c:symbol val="circle"/><c:size val="8"/><c:spPr><a:solidFill><a:srgbClr val="' + s.color + '"/></a:solidFill>' +
                '<a:ln w="9525"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:marker>') +
        "<c:xVal><c:numRef><c:f>" + esc(s.xRef) + "</c:f>" + numCache(s.xs, "General") + "</c:numRef></c:xVal>" +
        "<c:yVal><c:numRef><c:f>" + esc(s.yRef) + "</c:f>" + numCache(s.ys, "0.0%") + "</c:numRef></c:yVal>" +
        '<c:smooth val="0"/></c:ser>';
    });
    const gridLn = '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E4DCCD"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>';
    const axLn = '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="8C8579"/></a:solidFill></a:ln></c:spPr>';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<c:chartSpace xmlns:c="' + NS_C + '" xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '">' +
      '<c:roundedCorners val="0"/>' +
      "<c:chart>" +
      "<c:title>" + rich(ch.title, 1300, true) + '<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>' +
      "<c:plotArea><c:layout/>" +
      '<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>' + ser +
      '<c:axId val="50010"/><c:axId val="50020"/></c:scatterChart>' +
      '<c:valAx><c:axId val="50010"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>' +
      "<c:title>" + rich(ch.xTitle, 1000, false) + '<c:overlay val="0"/></c:title>' +
      '<c:numFmt formatCode="' + esc(ch.xFmt || "General") + '" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/>' +
      '<c:tickLblPos val="low"/>' + axLn + txPr(900) + '<c:crossAx val="50020"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>' +
      '<c:valAx><c:axId val="50020"/><c:scaling><c:orientation val="minMax"/><c:max val="1"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>' +
      gridLn + "<c:title>" + rich(ch.yTitle, 1000, false) + '<c:overlay val="0"/></c:title>' +
      '<c:numFmt formatCode="0%" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
      axLn + txPr(900) + '<c:crossAx val="50010"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/><c:majorUnit val="0.2"/></c:valAx>' +
      "</c:plotArea>" +
      '<c:legend><c:legendPos val="b"/><c:overlay val="0"/>' + txPr(900) + "</c:legend>" +
      '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>' +
      "</c:chart>" +
      '<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D2C5"/></a:solidFill></a:ln></c:spPr>' +
      "</c:chartSpace>";
  }

  function anchorXml(ch, id, rid) {
    return '<xdr:twoCellAnchor editAs="oneCell">' +
      "<xdr:from><xdr:col>" + ch.from.col + "</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>" + ch.from.row + "</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>" +
      "<xdr:to><xdr:col>" + ch.to.col + "</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>" + ch.to.row + "</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>" +
      '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="' + (id + 1) + '" name="' + esc(ch.title) + '"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>' +
      '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
      '<a:graphic><a:graphicData uri="' + NS_C + '"><c:chart xmlns:c="' + NS_C + '" r:id="' + rid + '"/></a:graphicData></a:graphic>' +
      "</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>";
  }

  function relsXml(rels) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' + NS_PR + '">' +
      rels.map((r) => '<Relationship Id="' + r.id + '" Type="' + r.type + '" Target="' + esc(r.target) + '"/>').join("") + "</Relationships>";
  }

  /** Path of a worksheet part (e.g. xl/worksheets/sheet2.xml) from its name. */
  async function sheetPath(zip, name) {
    const wbXml = await zip.file("xl/workbook.xml").async("string");
    const relXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");
    const sheetRe = /<sheet\b[^>]*>/g;
    let m, rid = null;
    while ((m = sheetRe.exec(wbXml))) {
      const nm = /\bname="([^"]*)"/.exec(m[0]);
      const id = /\br:id="([^"]*)"/.exec(m[0]);
      if (nm && id && unesc(nm[1]) === name) { rid = id[1]; break; }
    }
    if (!rid) throw new Error("sheet not found: " + name);
    const relRe = /<Relationship\b[^>]*>/g;
    while ((m = relRe.exec(relXml))) {
      const id = /\bId="([^"]*)"/.exec(m[0]);
      const tg = /\bTarget="([^"]*)"/.exec(m[0]);
      if (id && tg && id[1] === rid) {
        const t = unesc(tg[1]);
        return t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, "");
      }
    }
    throw new Error("sheet part not found: " + name);
  }

  async function addCharts(JSZip, buf, charts) {
    if (!charts || !charts.length) return buf;
    const zip = await JSZip.loadAsync(buf);
    const put = (path, data) => zip.file(path, data, { createFolders: false });
    let ct = await zip.file("[Content_Types].xml").async("string");
    let chartNo = 1;
    while (zip.file("xl/charts/chart" + chartNo + ".xml")) chartNo++;
    let drawNo = 1;
    while (zip.file("xl/drawings/drawing" + drawNo + ".xml")) drawNo++;

    const bySheet = new Map();
    for (const ch of charts) {
      if (!bySheet.has(ch.sheet)) bySheet.set(ch.sheet, []);
      bySheet.get(ch.sheet).push(ch);
    }
    for (const [name, list] of bySheet) {
      const sp = await sheetPath(zip, name);
      const dir = sp.slice(0, sp.lastIndexOf("/")), file = sp.slice(sp.lastIndexOf("/") + 1);
      const drawPath = "xl/drawings/drawing" + drawNo + ".xml";
      const drawRels = [];
      let anchors = "";
      list.forEach((ch, i) => {
        const cp = "xl/charts/chart" + chartNo + ".xml";
        put(cp, chartXml(ch));
        ct = ct.replace("</Types>", '<Override PartName="/' + cp + '" ContentType="' + CT_CHART + '"/></Types>');
        const rid = "rId" + (i + 1);
        drawRels.push({ id: rid, type: REL_CHART, target: "../charts/chart" + chartNo + ".xml" });
        anchors += anchorXml(ch, i + 1, rid);
        chartNo++;
      });
      put(drawPath, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '">' +
        anchors + "</xdr:wsDr>");
      put("xl/drawings/_rels/drawing" + drawNo + ".xml.rels", relsXml(drawRels));
      ct = ct.replace("</Types>", '<Override PartName="/' + drawPath + '" ContentType="' + CT_DRAWING + '"/></Types>');

      // sheet relationships: add the drawing
      const relPath = dir + "/_rels/" + file + ".rels";
      const relFile = zip.file(relPath);
      let rels = [];
      if (relFile) {
        const x = await relFile.async("string");
        const re = /<Relationship\b[^>]*\/?>/g;
        let m;
        while ((m = re.exec(x))) {
          const g = (a) => { const r = new RegExp("\\b" + a + '="([^"]*)"').exec(m[0]); return r ? unesc(r[1]) : null; };
          const r = { id: g("Id"), type: g("Type"), target: g("Target") };
          const mode = g("TargetMode");
          if (mode) r.mode = mode;
          rels.push(r);
        }
      }
      let n = 1;
      while (rels.some((r) => r.id === "rIdD" + n)) n++;
      const drawRid = "rIdD" + n;
      rels.push({ id: drawRid, type: REL_DRAWING, target: "../drawings/drawing" + drawNo + ".xml" });
      put(relPath, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' + NS_PR + '">' +
        rels.map((r) => '<Relationship Id="' + esc(r.id) + '" Type="' + esc(r.type) + '" Target="' + esc(r.target) + '"' +
                        (r.mode ? ' TargetMode="' + esc(r.mode) + '"' : "") + "/>").join("") + "</Relationships>");

      // <drawing r:id> must come after page setup elements and before legacyDrawing/tableParts/extLst
      let sx = await zip.file(sp).async("string");
      if (!/<worksheet\b[^>]*xmlns:r=/.test(sx)) sx = sx.replace(/<worksheet\b/, '<worksheet xmlns:r="' + NS_R + '"');
      const tag = '<drawing r:id="' + drawRid + '"/>';
      const before = ["<legacyDrawing", "<legacyDrawingHF", "<drawingHF", "<picture", "<oleObjects", "<controls", "<webPublishItems", "<tableParts", "<extLst", "</worksheet>"];
      let pos = -1;
      for (const b of before) { const p = sx.indexOf(b); if (p >= 0 && (pos < 0 || p < pos)) pos = p; }
      sx = sx.slice(0, pos) + tag + sx.slice(pos);
      put(sp, sx);
      drawNo++;
    }
    put("[Content_Types].xml", ct);
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  root.BR_XLCHARTS = { addCharts, chartXml };
})(typeof self !== "undefined" ? self : globalThis);
