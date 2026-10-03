// ==UserScript==
// @name         PMU - extraction rapports probables Couplé — réunion agrégée V20.11 — rapports probables / cale / CSV
// @version      20.11
// @description  Réunion complète : un tableau mémoire global, puis un seul CSV final.
// @match        https://www.pmu.fr/turf/*
// @grant        GM_setClipboard
// @grant        GM_download
// ==/UserScript==

(function() {
    'use strict';

    // Garde anti-double injection Tampermonkey/SPA
    if (window.__HIPPODATA_PROBABLES_V13__) return;
    window.__HIPPODATA_PROBABLES_V13__ = true;

    function simulateClick(el){
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const base = {bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0};
        el.dispatchEvent(new PointerEvent('pointerdown', {...base, pointerId: 1, pointerType: 'touch'}));
        el.dispatchEvent(new MouseEvent('mousedown', base));
        el.dispatchEvent(new PointerEvent('pointerup', {...base, pointerId: 1, pointerType: 'touch'}));
        el.dispatchEvent(new MouseEvent('mouseup', base));
        el.dispatchEvent(new MouseEvent('click', base));
    }

    function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

    // État de sécurité : les résultats sont persistés pendant l'extraction.
    let extractionRunning = false;
    let stopRequested = false;

    function cleanHorseText(s){
        return (s || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function isVisibleElement(el){
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
    }

    function getHorseRows(){
        const checkboxes = Array.from(
            document.querySelectorAll('[role="checkbox"]')
        ).filter(isVisibleElement);

        const seen = new Map();

        for (const checkbox of checkboxes){
            let node = checkbox.parentElement;
            let best = null;

            for (let depth = 0; node && depth < 8; depth++, node = node.parentElement){
                const text = cleanHorseText(node.innerText || node.textContent);
                if (!text || text.length > 450) continue;

                const m = text.match(/^(\d{1,2})\b/);
                const hasHorseMeta = /\bJockey\b/i.test(text) || /\bEntr\.?\b/i.test(text);

                if (m && hasHorseMeta){
                    best = { node, num: m[1], text };
                    break;
                }
            }

            if (!best){
                let node2 = checkbox.parentElement;
                for (let depth = 0; node2 && depth < 8; depth++, node2 = node2.parentElement){
                    const text = cleanHorseText(node2.innerText || node2.textContent);
                    if (!text || text.length > 450) continue;
                    const m = text.match(/(?:^|\s)(\d{1,2})\b/);
                    if (m && (/\bJockey\b/i.test(text) || /\bEntr\.?\b/i.test(text))){
                        best = { node: node2, num: m[1], text };
                        break;
                    }
                }
            }

            if (!best) continue;
            if (/non[- ]?partant/i.test(best.text)) continue;
            if (seen.has(best.num)) continue;

            best.node.__hippoCheckbox = checkbox;
            best.node.__hippoNum = best.num;
            best.node.__hippoText = best.text;
            seen.set(best.num, best.node);
        }

        return Array.from(seen.values()).sort((a,b) =>
            Number(getHorseNumber(a)) - Number(getHorseNumber(b))
        );
    }

    function getHorseNumber(row){
        if (row && row.__hippoNum) return row.__hippoNum;
        const el = row && row.querySelector('[data-testid="partant-number"]');
        if (el) return el.textContent.trim();
        const text = cleanHorseText(row && (row.innerText || row.textContent));
        const m = text.match(/^(\d{1,2})\b/);
        return m ? m[1] : '';
    }

    function getHorseName(row){
        if (row && row.getAttribute && row.getAttribute('aria-label')){
            return row.getAttribute('aria-label');
        }
        const text = cleanHorseText(row && (row.innerText || row.textContent));
        if (!text) return '';

        const lines = (row.innerText || row.textContent || '')
            .split(/\n+/)
            .map(x => x.trim())
            .filter(Boolean);

        if (lines.length >= 2 && /^\d{1,2}$/.test(lines[0])){
            return lines[1];
        }

        return text.replace(/^\d{1,2}\s*/, '');
    }

    function isChecked(row){
        const cb = getCheckbox(row);
        return !!cb && cb.getAttribute('aria-checked') === 'true';
    }

    function findLabelDiv(text){
        return Array.from(document.querySelectorAll('div[dir="auto"]'))
            .find(d => cleanHorseText(d.textContent).includes(text));
    }

    function extractMoney(text){
        const t = cleanHorseText(text);
        // Accepte les formats PMU usuels : 12 €, 12,50 €, 1 234,50 €,
        // mais aussi 12€ et, si nécessaire, € 12,50.
        const re = /(?:€\s*)?(?:\d{1,3}(?:[ .]\d{3})*|\d+)(?:[,.]\d{1,2})?\s*€/g;
        const m = t.match(re);
        if (m && m.length) return cleanHorseText(m[m.length - 1]);
        const re2 = /€\s*(?:\d{1,3}(?:[ .]\d{3})*|\d+)(?:[,.]\d{1,2})?/g;
        const m2 = t.match(re2);
        return m2 && m2.length ? cleanHorseText(m2[m2.length - 1]) : '';
    }

    function getRapportValue(){
        const dialog = document.querySelector('div[role="dialog"].content.open');
        if(!dialog || !isVisibleElement(dialog)) return '';
        const labels = Array.from(dialog.querySelectorAll('div[dir="auto"]'))
            .filter(isVisibleElement)
            .filter(el => /Rapport probable du e[- ]?Couplé Gagnant pour 1 €$/i.test(cleanHorseText(el.textContent)));
        if(!labels.length) return '';
        for(const label of labels){
            const parent = label.parentElement;
            if(!parent) continue;
            const siblings = Array.from(parent.children).filter(el => el !== label).filter(isVisibleElement);
            const exactMoney = /^(?:€\s*)?(?:\d{1,3}(?:[ .]\d{3})*|\d+)(?:[,.]\d{1,2})?\s*€$/;
            const exactEuroFirst = /^€\s*(?:\d{1,3}(?:[ .]\d{3})*|\d+)(?:[,.]\d{1,2})?$/;
            const value = siblings.find(el => { const t=cleanHorseText(el.textContent); return exactMoney.test(t)||exactEuroFirst.test(t); });
            if(value) return cleanHorseText(value.textContent);
        }
        return '';
    }

    function getRapportType(){
        const label = findLabelDiv('Rapport probable du');
        return label ? label.textContent.replace(/\u00a0/g, ' ').trim() : '';
    }

    function getEnjeuxTotal(){
        const label = findLabelDiv('Rapports probables du');
        if (!label) return '';
        const wrapper = label.parentElement;
        const sib = wrapper.nextElementSibling;
        return sib ? sib.textContent.replace(/\u00a0/g, ' ').trim() : '';
    }

    function getCheckbox(row){
        return (row && row.__hippoCheckbox) || row.querySelector('[role="checkbox"]');
    }

    async function uncheckAll(rows){
        for (const row of rows){
            if (isChecked(row)){
                getCheckbox(row).click();
                await sleep(200);
            }
        }
    }

    function waitForValueChange(previousValue, timeoutMs = 1800){
        return new Promise(resolve => {
            const started = Date.now();
            let finished = false;
            let observer = null;
            let timer = null;

            const finish = value => {
                if (finished) return;
                finished = true;
                if (observer) observer.disconnect();
                if (timer) clearTimeout(timer);
                resolve(value);
            };

            const check = () => {
                const current = getRapportValue();
                if (current !== previousValue && current !== '') {
                    finish(current);
                    return;
                }
                if (Date.now() - started >= timeoutMs) {
                    finish(current);
                    return;
                }
                setTimeout(check, 45);
            };

            try{
                observer = new MutationObserver(() => check());
                observer.observe(document.body, {
                    subtree: true,
                    childList: true,
                    characterData: true,
                    attributes: true,
                    attributeFilter: ['aria-label', 'aria-checked']
                });
            }catch(e){
                observer = null;
            }

            timer = setTimeout(() => finish(getRapportValue()), timeoutMs);
            check();
        });
    }

    function createPairTable(rows){
        const table = [];
        for(let i = 0; i < rows.length - 1; i++){
            for(let j = i + 1; j < rows.length; j++){
                table.push({
                    i,
                    j,
                    aNum: getHorseNumber(rows[i]),
                    aName: getHorseName(rows[i]),
                    bNum: getHorseNumber(rows[j]),
                    bName: getHorseName(rows[j]),
                    type: '',
                    rapport: '',
                    enjeux: '',
                    recupereLe: ''
                });
            }
        }
        return table;
    }

    async function runExtraction(statusEl){
        stopRequested = false;
        const info = getCourseInfo();
        const rows = getHorseRows();
            if(rows.length < 2){
                const cbCount = document.querySelectorAll('[role="checkbox"]').length;
                if(statusEl) statusEl.textContent='Échec : '+rows.length+' partant(s) détecté(s), cases DOM : '+cbCount;
                return false;
            }

            if(statusEl){
                statusEl.style.display = 'block';
                statusEl.textContent = 'Partants détectés : ' + rows.length;
            }

            await uncheckAll(rows);
            const enjeuxTotal = getEnjeuxTotal();
            const n = rows.length;
            const totalPaires = (n * (n - 1)) / 2;
            const pairTable = createPairTable(rows);
            let done = 0;

            for(let i = 0; i < n - 1; i++){
                if(stopRequested) break;
                const cbA = getCheckbox(rows[i]);
                if(!cbA) continue;

                cbA.click();
                await sleep(60);

                for(let j = i + 1; j < n; j++){
                    if(stopRequested) break;
                    const cbB = getCheckbox(rows[j]);
                    if(!cbB) continue;

                    const before = getRapportValue();
                    cbB.click();

                    const rapportValue = await waitForValueChange(before, 1800);
                    const rapportType = getRapportType();
                    const now = new Date().toLocaleString('fr-FR');

                    const rowIndex = done;
                    if(pairTable[rowIndex]){
                        pairTable[rowIndex].type = rapportType || 'e-Couplé Gagnant';
                        pairTable[rowIndex].rapport = rapportValue;
                        pairTable[rowIndex].enjeux = enjeuxTotal;
                        pairTable[rowIndex].recupereLe = now;
                    }

                    done++;

                    // IMPORTANT : sauvegarde après CHAQUE couple récupéré.
                    // Une interruption ou un changement de page ne détruit donc
                    // plus le tableau récolté jusque-là.
                    if(info) persistCourseTable(pairTable, info);

                    if(statusEl){
                        const pct = Math.round(done * 100 / totalPaires);
                        const aggregateCount = info ? loadAggregate({date:info.date,reunion:info.reunion}).length : 0;
                        statusEl.textContent =
                            `Extraction… ${done}/${totalPaires} (${pct} %) — CALE : ${aggregateCount} ligne(s)`;
                        updateSaveButton(document.getElementById('hippodata-save-btn'));
                    }

                    cbB.click();
                    await sleep(45);
                }

                if(isChecked(rows[i])) cbA.click();
                await sleep(45);
            }

            if(stopRequested && statusEl){
                statusEl.textContent=`⏹ Extraction arrêtée : ${done}/${totalPaires} couples traités — tableau sauvegardé.`;
            }

            const found = pairTable.filter(x => x.rapport !== '').length;
            const missing = totalPaires - found;
            return { pairTable, totalPaires, found, missing, stopped: stopRequested };
    }

    function buildCsv(rows){
        const headers = [
            'Date', 'Réunion', 'Course',
            'Cheval A (num)', 'Cheval A (nom)',
            'Cheval B (num)', 'Cheval B (nom)',
            'Type de pari', 'Rapport probable',
            'Enjeux totaux (course)', 'Récupéré le'
        ];
        const csvLines = [headers, ...rows].map(row =>
            row.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(';')
        );
        return '\uFEFF' + csvLines.join('\n');
    }

    // EXPORT TESTÉ SUR ANDROID/FIREFOX :
    // Blob -> URL.createObjectURL -> <a download> -> clic navigateur.
    // Le test indépendant de 10 valeurs a démontré que ce mécanisme
    // ouvre la boîte native « Télécharger le fichier ? » et produit
    // un fichier CSV lisible.
    function exportCsvOnce(csv, filename, statusEl){
        try{ GM_setClipboard(csv); }catch(e){}

        try {
            const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
            const blobUrl = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            a.style.display = 'none';

            document.body.appendChild(a);
            a.click();
            a.remove();

            setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);

            // Pas de message « CSV construit… » : le téléchargement natif
            // de Firefox/Tampermonkey constitue lui-même la preuve d'enregistrement.
            return true;
        } catch(e){
            console.error('Export CSV impossible:', e);
            if(statusEl){
                statusEl.textContent =
                    `❌ Export impossible : ${e&&e.message?e.message:e}`;
            }
            return false;
        }
    }

    function exportResultsFromPairTable(pairTable, totalPaires, found, missing, statusEl){
        const m = location.pathname.match(/\/turf\/(\d{8})\/r(\d+)\/c(\d+)\/?/i);
        const dateKey = m ? m[1] : 'date';
        const reunion = m ? 'R' + m[2] : 'R?';
        const course = m ? 'C' + m[3] : 'C?';
        const rows = pairTable.filter(x=>x.rapport!=='').map(item=>[dateKey,reunion,course,item.aNum,item.aName,item.bNum,item.bName,item.type,item.rapport,item.enjeux,item.recupereLe]);
        const csv=buildCsv(rows);
        const filename=`rapports_couples_${dateKey}_${reunion}${course}.csv`;
        return exportCsvOnce(csv,filename,statusEl);
    }

    function chooseDateWithCalendar(){
        return new Promise(resolve => {
            const overlay=document.createElement('div');
            overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000000;display:flex;align-items:center;justify-content:center;padding:12px;';
            const box=document.createElement('div');
            box.style.cssText='background:#fff;color:#222;width:min(360px,94vw);border-radius:14px;padding:16px;font-family:Arial,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);';
            let cursor=new Date(); cursor.setHours(12,0,0,0);
            const title=document.createElement('div');
            title.style.cssText='font-size:18px;font-weight:bold;text-align:center;margin-bottom:12px;';
            const nav=document.createElement('div');
            nav.style.cssText='display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
            const grid=document.createElement('div');
            grid.style.cssText='display:grid;grid-template-columns:repeat(7,1fr);gap:4px;text-align:center;';
            const cancel=document.createElement('button'); cancel.textContent='Annuler';
            cancel.style.cssText='margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;background:#777;color:#fff;';
            const makeButton=(txt,fn)=>{const b=document.createElement('button');b.textContent=txt;b.style.cssText='border:0;border-radius:8px;background:#eee;padding:8px 12px;font-size:18px;';b.addEventListener('click',fn);return b;};
            const close=value=>{overlay.remove();resolve(value);};
            cancel.onclick=()=>close(null);
            const render=()=>{
                title.textContent=cursor.toLocaleDateString('fr-FR',{month:'long',year:'numeric'});
                grid.innerHTML='';
                ['L','M','M','J','V','S','D'].forEach(d=>{const h=document.createElement('div');h.textContent=d;h.style.cssText='font-weight:bold;font-size:12px;padding:4px;';grid.appendChild(h);});
                const year=cursor.getFullYear(), month=cursor.getMonth();
                const first=new Date(year,month,1); const start=(first.getDay()+6)%7; const days=new Date(year,month+1,0).getDate();
                for(let i=0;i<start;i++) grid.appendChild(document.createElement('div'));
                for(let day=1;day<=days;day++){
                    const b=document.createElement('button'); b.textContent=day;
                    b.style.cssText='border:0;border-radius:8px;background:#f1f1f1;padding:9px 0;font-size:14px;';
                    b.onclick=()=>{const dd=String(day).padStart(2,'0'),mm=String(month+1).padStart(2,'0');close(`${dd}${mm}${year}`);};
                    grid.appendChild(b);
                }
            };
            nav.append(makeButton('‹',()=>{cursor.setMonth(cursor.getMonth()-1);render();}),title,makeButton('›',()=>{cursor.setMonth(cursor.getMonth()+1);render();}));
            box.append(nav,grid,cancel); overlay.appendChild(box); document.body.appendChild(overlay); render();
        });
    }

    async function chooseRace(){
        const current=location.pathname.match(/\/turf\/(?:\d{8}\/)?r(\d+)\/c(\d+)\/?/i);
        const defaultRace=current?`R${current[1]}C${current[2]}`:'R1C1';
        const dateKey=await chooseDateWithCalendar(); if(!dateKey)return;
        const answer=prompt('Quelle course veux-tu charger ?\n\nFormat : R1C4, R2C7, etc.',defaultRace); if(answer===null)return;
        const m=answer.trim().replace(/\s+/g,'').toUpperCase().match(/^R(\d+)C(\d+)$/);
        if(!m){alert('Format incorrect.\n\nExemple correct : R1C4');return;}
        const reunion=Number(m[1]),course=Number(m[2]);
        if(reunion<1||course<1){alert('La réunion et la course doivent être supérieures à 0.');return;}
        const url=`${location.origin}/turf/${dateKey}/r${reunion}/c${course}/`;
        location.href=url;
    }

    function normNav(s){
        return (s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
    }

    function findVisibleTextTarget(terms){
        const wanted = terms.map(normNav);
        const all = Array.from(document.querySelectorAll('body *'));

        const matches = all.filter(el => {
            if (!el || el.children.length > 0) return false;
            const t = normNav(el.textContent);
            if (!t) return false;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            if (getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).display === 'none') return false;
            return wanted.some(term => t === term || t.includes(term));
        });

        if (!matches.length) return null;

        for (const leaf of matches) {
            let el = leaf;
            for (let i=0; i<5 && el; i++, el=el.parentElement){
                if (el.matches('button,a,[role="tab"],[role="button"]')) return el;
            }
            return leaf;
        }
        return null;
    }

    function findNavElement(terms){
        const els=Array.from(document.querySelectorAll('button,a,[role="tab"],[role="button"]'))
            .filter(isVisibleElement);
        const wanted=terms.map(normNav);
        const direct=els.find(el=>{
            const text=normNav(el.textContent), aria=normNav(el.getAttribute('aria-label')), title=normNav(el.getAttribute('title'));
            return wanted.some(term=>text===term||text.includes(term)||aria===term||aria.includes(term)||title===term||title.includes(term));
        });
        return direct || findVisibleTextTarget(terms);
    }

    function safeNavClick(el){
        if (!el) return false;
        try { el.scrollIntoView({block:'center', inline:'center'}); } catch(e) {}
        try {
            el.click();
            return true;
        } catch(e) {}
        try {
            simulateClick(el);
            return true;
        } catch(e) {
            console.error('HIPPODATA navigation click:', e);
            return false;
        }
    }

    async function clickNavWhenFound(terms,label,attempts=50){
        for(let i=0;i<attempts;i++){
            const el=findNavElement(terms);
            if(el){
                const ok=safeNavClick(el);
                if(ok){
                    await sleep(1400);
                    return true;
                }
            }
            await sleep(500);
        }
        console.log('HIPPODATA : introuvable -> '+label);
        return false;
    }

    // Réparation V20.1 : attente du véritable panneau e.Couplé.
    // On ne change ni la navigation ni les clics ; on attend simplement
    // que le contenu du panneau soit effectivement présent dans le DOM.
    async function waitForProbablePanel(statusEl, timeoutMs=12000){
        const started=Date.now();

        while(Date.now()-started < timeoutMs){
            const labels = Array.from(document.querySelectorAll('div[dir="auto"]'))
                .map(el => cleanHorseText(el.textContent))
                .filter(Boolean);

            const hasReportLabel = labels.some(t => /Rapport probable du/i.test(t));
            const hasPartantCheckbox = Array.from(
                document.querySelectorAll('[role="checkbox"]')
            ).some(isVisibleElement);

            if(hasReportLabel && hasPartantCheckbox){
                if(statusEl) statusEl.textContent='Panneau e.Couplé prêt.';
                return true;
            }

            await sleep(250);
        }

        return false;
    }

    async function openProbableCouples(statusEl){
        statusEl.textContent='Recherche : Rapports probables…';
        const probable=await clickNavWhenFound([
            'rapports probables','rapports probable','rapport probable'
        ],'Rapports probables');
        if(!probable){
            statusEl.textContent='Échec : Rapports probables introuvable.';
            return false;
        }

        statusEl.textContent='Rapports probables ouvert. Recherche : e.Couplé…';
        await sleep(1200);

        let couples=null;
        for(let i=0;i<30 && !couples;i++){
            couples=findNavElement(['e.couplé','e.couples','e.couple','couplés','couples']);
            if(!couples) await sleep(400);
        }
        if(couples){
            const clicked=safeNavClick(couples);
            if(clicked) await sleep(900);
        }

        if(!couples){
            statusEl.textContent='Échec : e.Couplé introuvable.';
            return false;
        }

        const couplesReady=await waitForProbablePanel(statusEl);
        if(!couplesReady){
            statusEl.textContent='e.Couplé visible, mais panneau des rapports non chargé.';
            return false;
        }
        return true;
    }

    function getCourseInfo(){
        const m = location.pathname.match(/\/turf\/(\d{8})\/r(\d+)\/c(\d+)\/?/i);
        return m ? {date:m[1], reunion:Number(m[2]), course:Number(m[3])} : null;
    }

    function discoverMeetingCourses(){
        const info=getCourseInfo();
        if(!info) return [];
        const set=new Set([info.course]);
        const routeRe=new RegExp('/turf/'+info.date+'/r'+info.reunion+'/c(\\d+)', 'gi');

        // 1) Liens/éléments de navigation déjà présents dans le DOM.
        document.querySelectorAll('a[href],button,[role="button"],[role="tab"]').forEach(el=>{
            const href=el.getAttribute('href')||'';
            let m;
            while((m=routeRe.exec(href))!==null) set.add(Number(m[1]));

            const t=cleanHorseText(el.textContent);
            const tm=t.match(/^(?:C(?:ourse)?\s*)?(\d{1,2})$/i);
            if(tm && Number(tm[1])>=1 && Number(tm[1])<=30) set.add(Number(tm[1]));
        });

        // 2) PMU peut conserver les routes des courses dans le HTML/état
        // React même lorsqu'elles ne sont pas matérialisées par des liens.
        const html=document.documentElement ? document.documentElement.innerHTML : '';
        routeRe.lastIndex=0;
        let m;
        while((m=routeRe.exec(html))!==null) set.add(Number(m[1]));

        // 3) Quelques habillages exposent simplement des libellés « Course X ».
        const text=cleanHorseText(document.body ? document.body.innerText : '');
        const courseRe=/(?:^|\s)(?:C|Course)\s*(\d{1,2})(?=\s|$)/gi;
        while((m=courseRe.exec(text))!==null) set.add(Number(m[1]));

        return Array.from(set).filter(n=>Number.isFinite(n) && n>=1 && n<=30).sort((a,b)=>a-b);
    }
    function meetingKey(){
        const info=getCourseInfo();
        return info ? `HIPPODATA_REUNION_${info.date}_R${info.reunion}` : '';
    }

    function aggregateKey(date,reunion){ return `HIPPODATA_AGG_${date}_R${reunion}`; }

    function loadAggregate(state){
        try {
            const raw=sessionStorage.getItem(aggregateKey(state.date,state.reunion));
            return raw ? JSON.parse(raw) : [];
        } catch(e){ console.error('Lecture agrégat:',e); return []; }
    }

    function saveAggregate(state, rows){
        sessionStorage.setItem(aggregateKey(state.date,state.reunion), JSON.stringify(rows));
    }

    // Diagnostic de cale : état unique et lisible du contenu réellement mémorisé.
    function getHoldInfo(){
        const info=getCourseInfo();
        if(!info) return {count:0, courses:[], label:'cale inconnue'};
        const rows=loadAggregate({date:info.date,reunion:info.reunion});
        const courses=[...new Set(rows.map(r=>r[2]).filter(Boolean))];
        return {count:rows.length, courses, label:`${rows.length} ligne(s) — ${courses.length} course(s) en cale`};
    }

    function updateSaveButton(button){
        if(!button) return;
        const hold=getHoldInfo();
        if(extractionRunning){
            button.textContent=`⏹ ARRÊTER + SAUVER (${hold.count})`;
        }else{
            button.textContent=`💾 SAUVER LA CALE (${hold.count})`;
        }
        button.title=hold.label;
    }

    function pairTableToRows(pairTable, info){
        const date=info.date, reunion='R'+info.reunion, course='C'+info.course;
        return pairTable.filter(x=>x.rapport!=='').map(item=>[date,reunion,course,item.aNum,item.aName,item.bNum,item.bName,item.type,item.rapport,item.enjeux,item.recupereLe]);
    }

    // Persistance immédiate : on remplace uniquement les lignes de la course
    // en cours, puis on conserve toutes les autres courses déjà récoltées.
    function persistCourseTable(pairTable, info){
        if(!info) return [];
        const state={date:info.date,reunion:info.reunion};
        const currentRows=pairTableToRows(pairTable,info);
        const oldRows=loadAggregate(state).filter(row =>
            !(row[0]===info.date && row[1]==='R'+info.reunion && row[2]==='C'+info.course)
        );
        const aggregate=oldRows.concat(currentRows);
        saveAggregate(state,aggregate);
        return aggregate;
    }

    function exportCurrentAggregate(statusEl){
        const info=getCourseInfo();
        if(!info){
            if(statusEl) statusEl.textContent='Impossible d’identifier la réunion en cours.';
            return false;
        }
        const state={date:info.date,reunion:info.reunion};
        const rows=loadAggregate(state);
        if(!rows.length){
            if(statusEl) statusEl.textContent='Aucun résultat enregistré pour cette réunion.';
            return false;
        }
        const csv=buildCsv(rows);
        const filename=`HIPPODATA_rapports_${state.date}_R${state.reunion}_ARRET_${rows.length}_LIGNES.csv`;
        return exportCsvOnce(csv,filename,statusEl);
    }

    async function requestStopAndSave(statusEl){
        // Le drapeau arrête la boucle dès que possible et, s'il existe
        // une réunion automatique en cours, sa clé de navigation est retirée :
        // aucune course suivante ne sera lancée après l'arrêt.
        stopRequested=true;
        const key=meetingKey();
        if(key) sessionStorage.removeItem(key);

        if(statusEl) statusEl.textContent='⏹ Arrêt demandé — sauvegarde du tableau en cours…';
        while(extractionRunning){
            await sleep(100);
        }
        exportCurrentAggregate(statusEl);
    }

    function finalAggregateExport(state,statusEl){
        const rows=loadAggregate(state);
        if(!rows.length){
            if(statusEl) statusEl.textContent='Aucune donnée à exporter.';
            return false;
        }
        const csv=buildCsv(rows);
        const filename=`HIPPODATA_rapports_${state.date}_R${state.reunion}_${rows.length}_LIGNES.csv`;
        const ok=exportCsvOnce(csv,filename,statusEl);
        return ok;
    }

    async function waitForCourseTable(statusEl){
        for(let i=0;i<80;i++){
            const rows=getHorseRows();
            if(rows.length>=2){
                if(statusEl) statusEl.textContent=`Tableau détecté : ${rows.length} partants`;
                return true;
            }
            if(statusEl) statusEl.textContent='Attente du tableau des partants…';
            await sleep(500);
        }
        return false;
    }

    async function continueMeeting(statusEl){
        const key=meetingKey();
        if(!key) return false;
        const raw=sessionStorage.getItem(key);
        if(!raw) return false;
        const state=JSON.parse(raw);
        const info=getCourseInfo();
        if(!info || info.course!==state.course) return false;

        if(state.discover || !Array.isArray(state.courses) || !state.courses.length){
            for(let i=0;i<20;i++){
                const found=discoverMeetingCourses();
                if(found.length){
                    state.courses=found;
                    state.discover=false;
                    sessionStorage.setItem(key,JSON.stringify(state));
                    break;
                }
                await sleep(500);
            }
        }
        let courses=state.courses;
        if(statusEl && courses && courses.length) statusEl.textContent=`Réunion R${state.reunion} : ${courses.length} course(s) détectée(s) — C${info.course}`;
        if(!courses || !courses.length){
            statusEl.textContent='Impossible d’identifier les courses de la réunion.';
            return false;
        }

        if(statusEl) statusEl.textContent=`Réunion R${state.reunion} — C${info.course}/${courses.length} — préparation`;
        const tableReady=await waitForCourseTable(statusEl);
        if(!tableReady){ statusEl.textContent=`C${info.course} : tableau non détecté.`; return false; }

        const opened=await openProbableCouples(statusEl);
        if(!opened) return false;
        const ready=await waitForProbablePanel(statusEl);
        if(!ready){ statusEl.textContent=`C${info.course} : tableau e.Couplé non chargé.`; return false; }

        extractionRunning=true;
        updateSaveButton(document.getElementById('hippodata-save-btn'));
        const result=await runExtraction(statusEl);
        extractionRunning=false;
        updateSaveButton(document.getElementById('hippodata-save-btn'));
        if(!result || !result.pairTable) return false;
        const aggregate=loadAggregate(state);
        const newRows=pairTableToRows(result.pairTable,info);
        if(statusEl) statusEl.textContent=`C${info.course} terminée : ${newRows.length} rapports — total réunion ${aggregate.length}`;

        if(result.stopped){
            if(statusEl) statusEl.textContent=`⏹ Réunion interrompue à C${info.course} : ${aggregate.length} rapports sauvegardés.`;
            return true;
        }

        const pos=courses.indexOf(info.course);
        const next=courses[pos+1];
        if(next){
            state.course=next;
            sessionStorage.setItem(key,JSON.stringify(state));
            await sleep(700);
            location.href=`${location.origin}/turf/${state.date}/r${state.reunion}/c${next}/`;
            return true;
        }

        const exported=finalAggregateExport(state,statusEl);
        if(exported){
            sessionStorage.removeItem(key);
            if(statusEl) statusEl.textContent=`✅ Réunion terminée : ${aggregate.length} rapports — CSV unique lancé.`;
        }
        return true;
    }

    async function startMeeting(){
        const dateKey=await chooseDateWithCalendar();
        if(!dateKey)return;
        const answer=prompt('Quelle réunion veux-tu traiter ?\n\nFormat : R1, R2, etc.','R1');
        if(answer===null)return;
        const m=answer.trim().toUpperCase().match(/^R(\d+)$/);
        if(!m){alert('Format incorrect. Exemple : R1');return;}
        const reunion=Number(m[1]);
        const key=`HIPPODATA_REUNION_${dateKey}_R${reunion}`;
        sessionStorage.removeItem(aggregateKey(dateKey,reunion));
        sessionStorage.setItem(key,JSON.stringify({date:dateKey,reunion,courses:[],course:1,discover:true}));
        location.href=`${location.origin}/turf/${dateKey}/r${reunion}/c1/`;
    }

    function dateKeyForFile(){
        const m = location.pathname.match(/\/turf\/(\d{8})\//i);
        return m ? m[1] : 'date';
    }

    function addInterface(){
        if(document.getElementById('hippodata-pmu-extractor'))return;
        const container=document.createElement('div'); container.id='hippodata-pmu-extractor';
        container.style.cssText='position:fixed;bottom:20px;right:20px;z-index:999999;display:flex;flex-direction:column;align-items:flex-end;gap:6px;';
        const status=document.createElement('div'); status.id='hippodata-pmu-status'; status.style.cssText='background:#fff;color:#173425;padding:6px 10px;border-radius:6px;font-size:12px;box-shadow:0 2px 6px rgba(0,0,0,.3);'; status.style.display='none';
        const raceBtn=document.createElement('button'); raceBtn.textContent='🏇 Choisir une course'; raceBtn.style.cssText='background:#7A1F2B;color:#fff;padding:10px 14px;border-radius:8px;border:none;font-size:13px;'; raceBtn.onclick=chooseRace;
        const meetingBtn=document.createElement('button'); meetingBtn.textContent='🏇 Toute la réunion'; meetingBtn.style.cssText='background:#5A3D8E;color:#fff;padding:10px 14px;border-radius:8px;border:none;font-size:13px;'; meetingBtn.onclick=startMeeting;
        const extractBtn=document.createElement('button'); extractBtn.textContent='▶ Extraire les rapports probables'; extractBtn.style.cssText='background:#173425;color:#fff;padding:14px;border-radius:8px;border:none;font-size:14px;';

        // Bouton unique présent AVANT, PENDANT et APRÈS le traitement.
        // Avant/après : sauvegarde de la cale. Pendant : arrêt + sauvegarde.
        const saveBtn=document.createElement('button');
        saveBtn.id='hippodata-save-btn';
        saveBtn.style.cssText='background:#8B1E1E;color:#fff;padding:12px 14px;border-radius:8px;border:none;font-size:13px;';
        saveBtn.onclick=async()=>{
            saveBtn.disabled=true;
            status.style.display='block';
            if(extractionRunning){
                await requestStopAndSave(status);
            }else{
                const hold=getHoldInfo();
                if(!hold.count){
                    status.textContent='❌ ERREUR : pas de données dans la cale.';
                }else{
                    status.textContent=`💾 Cale : ${hold.label}. Enregistrement demandé…`;
                    exportCurrentAggregate(status);
                }
            }
            updateSaveButton(saveBtn);
            saveBtn.disabled=false;
            extractBtn.disabled=false; raceBtn.disabled=false; meetingBtn.disabled=false;
        };

        extractBtn.onclick=async()=>{
            extractBtn.disabled=true; raceBtn.disabled=true; meetingBtn.disabled=true;
            status.style.display='block';
            try{
                const opened=await openProbableCouples(status);
                if(opened){
                    extractionRunning=true;
                    updateSaveButton(saveBtn);
                    await runExtraction(status);
                }
            }catch(err){
                alert('ERREUR : '+(err&&err.message?err.message:err)); console.error(err);
            }finally{
                extractionRunning=false;
                updateSaveButton(saveBtn);
                extractBtn.disabled=false; raceBtn.disabled=false; meetingBtn.disabled=false;
                const hold=getHoldInfo();
                status.textContent=`État de la cale : ${hold.label}.`;
            }
        };

        container.append(status,raceBtn,meetingBtn,extractBtn,saveBtn); document.body.appendChild(container);
        updateSaveButton(saveBtn);
    }

    async function bootMeetingIfNeeded(){
        const info=getCourseInfo();
        if(!info) return;
        const key=meetingKey();
        if(!key) return;
        const raw=sessionStorage.getItem(key);
        if(!raw) return;

        try{
            const state=JSON.parse(raw);
            if(!state || !state.reunion || state.reunion!==info.reunion || state.course!==info.course) return;

            const status=document.getElementById('hippodata-pmu-status');
            const buttons=document.querySelectorAll('#hippodata-pmu-extractor button');
            buttons.forEach(b=>{ if(b.id!=='hippodata-save-btn') b.disabled=true; });
            const stopBtn=document.querySelector('#hippodata-pmu-extractor button:last-child');
            if(stopBtn) { stopBtn.style.display='block'; stopBtn.disabled=false; }
            if(status){status.style.display='block';status.textContent=`Réunion R${info.reunion} : préparation C${info.course}…`;}

            await sleep(800);
            await continueMeeting(status);
        }catch(err){
            console.error('HIPPODATA réunion:',err);
            sessionStorage.removeItem(key);
            alert('ERREUR réunion : '+(err&&err.message?err.message:err));
        }finally{
            const buttons=document.querySelectorAll('#hippodata-pmu-extractor button');
            buttons.forEach(b=>{ if(b.id!=='hippodata-save-btn') b.disabled=false; });

            // V20.6 : le bouton de sauvegarde est PERMANENT.
            // Il ne doit jamais être masqué à la fin d'une course ou d'une réunion.
            const saveBtn=document.getElementById('hippodata-save-btn');
            if(saveBtn){
                saveBtn.style.display='block';
                saveBtn.disabled=false;
                updateSaveButton(saveBtn);
            }
        }
    }

    if(document.readyState==='loading'){
        document.addEventListener('DOMContentLoaded',()=>{
            addInterface();
            setTimeout(bootMeetingIfNeeded,800);
        });
    }else{
        addInterface();
        setTimeout(bootMeetingIfNeeded,800);
    }
})();