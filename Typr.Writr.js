var Typr = Typr || {};

Typr.Writer = (function() {

	function write(font, chars) {
		var hasGlyf = Typr.findTable(font._data, "glyf", font._offset) != null && font.glyf != null;
		var hasCFF  = Typr.findTable(font._data, "CFF ", font._offset) != null;
		var hasCFF2 = Typr.findTable(font._data, "CFF2", font._offset) != null;

		if(!hasGlyf && (hasCFF || hasCFF2)) return writeCFF(font, chars, hasCFF2);
		if(!hasGlyf) throw new Error("Unsupported font: no glyf or CFF outlines found.");
		return writeGlyf(font, chars);
	}

	// ------------------------------------------------------------------
	// TrueType (glyf) fonts: subset with glyph renumbering
	// ------------------------------------------------------------------

	function writeGlyf(font, chars) {
		// Identify Glyphs
		// Always include .notdef (0)
		var glyphs = [0];
		var charToGlyph = {};
		var old2new = {0:0};

		// Collect requested glyphs
		for(var i=0; i<chars.length; i++) {
			var code = chars.codePointAt(i);
			if(code>0xffff) i++;
			var gid = Typr.U.codeToGlyph(font, code);
			if(gid != 0) {
				if(old2new[gid] == null) {
					old2new[gid] = glyphs.length;
					glyphs.push(gid);
				}
				charToGlyph[code] = old2new[gid];
			}
		}

		// Add dependencies (composite glyphs), scanning the raw glyf bytes.
		// We iterate until no new glyphs are added (nested composites).
		var glyfOffset = Typr.findTable(font._data, "glyf", font._offset)[0];
		var ptr = 0;
		while(ptr < glyphs.length) {
			var gid = glyphs[ptr++];
			var len = font.loca[gid+1] - font.loca[gid];
			if(len == 0) continue;

			scanComposite(font._data, glyfOffset + font.loca[gid], function(pos, compGid) {
				if(compGid >= font.maxp.numGlyphs) return; // malformed component reference
				if(old2new[compGid] == null) {
					old2new[compGid] = glyphs.length;
					glyphs.push(compGid);
				}
			});
		}

		// Build Tables
		var tables = {};

		// Head
		tables.head = copyTable(font, "head");
		tables.head.setUint16(50, 0); // indexToLocFormat (will be set later)

		// Hhea
		tables.hhea = copyTable(font, "hhea");
		tables.hhea.setUint16(34, glyphs.length); // numberOfHMetrics

		// Maxp
		tables.maxp = copyTable(font, "maxp");
		tables.maxp.setUint16(4, glyphs.length); // numGlyphs

		// OS/2, name - Copy as is
		tables["OS/2"] = copyTable(font, "OS/2");
		tables.name = copyTable(font, "name");

		// Hinting tables - Copy if they exist to preserve hinting
		var hintingTables = ["cvt ", "fpgm", "prep", "gasp"];
		for(var i=0; i<hintingTables.length; i++) {
			var t = copyTable(font, hintingTables[i]);
			if(t) tables[hintingTables[i]] = t;
		}

		// Post - Create new version 3.0 table
		tables.post = createPost(font);

		// Hmtx
		tables.hmtx = createHmtx(font, glyphs);

		// Glyf & Loca
		var glResult = createGlyf(font, glyphs, old2new);
		tables.glyf = glResult.glyf;
		tables.loca = glResult.loca;
		if(glResult.isLongLoca) {
			tables.head.setUint16(50, 1); // indexToLocFormat = 1 (long)
		} else {
			tables.head.setUint16(50, 0); // indexToLocFormat = 0 (short)
		}

		// Cmap
		tables.cmap = createCmap(charToGlyph);

		// Assemble
		return createFont(tables);
	}

	// Walks the components of a glyph (raw bytes starting at "start").
	// Calls cb(posOfGlyphIndex, glyphIndex) for every component.
	// Does nothing for simple/empty glyphs.
	function scanComposite(data, start, cb) {
		var numberOfContours = (((data[start]<<8) | data[start+1]) << 16) >> 16;
		if(numberOfContours >= 0) return;

		var ARG_1_AND_2_ARE_WORDS   = 1<<0;
		var WE_HAVE_A_SCALE         = 1<<3;
		var MORE_COMPONENTS         = 1<<5;
		var WE_HAVE_AN_X_AND_Y_SCALE= 1<<6;
		var WE_HAVE_A_TWO_BY_TWO    = 1<<7;

		var pos = start + 10; // Header size
		var flags = 0;
		do {
			flags = (data[pos]<<8) | data[pos+1];
			var glyphIndex = (data[pos+2]<<8) | data[pos+3];
			cb(pos+2, glyphIndex);
			pos += 4;

			if(flags & ARG_1_AND_2_ARE_WORDS) pos += 4;
			else pos += 2;

			if(flags & WE_HAVE_A_SCALE) pos += 2;
			else if(flags & WE_HAVE_AN_X_AND_Y_SCALE) pos += 4;
			else if(flags & WE_HAVE_A_TWO_BY_TWO) pos += 8;

		} while(flags & MORE_COMPONENTS);
	}

	function copyTable(font, name) {
		var buf = copyTableBytes(font, name);
		if(!buf) return null;
		return new DataView(buf.buffer);
	}

	function copyTableBytes(font, name) {
		// We need the raw bytes. Typr stores offsets in font._data
		var data = font._data;
		var offset = Typr.findTable(data, name, font._offset);
		if(!offset) return null;

		var off = offset[0];
		var len = offset[1];

		var buf = new Uint8Array(len);
		for(var i=0; i<len; i++) buf[i] = data[off+i];
		return buf;
	}

	function createHmtx(font, glyphs) {
		var len = glyphs.length * 4;
		var buf = new ArrayBuffer(len);
		var view = new DataView(buf);

		for(var i=0; i<glyphs.length; i++) {
			var gid = glyphs[i];
			var aw = font.hmtx.aWidth[gid];
			var lsb = font.hmtx.lsBearing[gid];
			view.setUint16(i*4, aw);
			view.setInt16(i*4+2, lsb);
		}
		return view;
	}

	function createGlyf(font, glyphs, old2new) {
		// First pass: calculate size
		var size = 0;
		var loca = [];
		var glyfParts = [];

		var glyfOffset = Typr.findTable(font._data, "glyf", font._offset)[0];

		for(var i=0; i<glyphs.length; i++) {
			loca.push(size);
			var gid = glyphs[i];

			var data = font._data;
			var offset = glyfOffset + font.loca[gid];
			var len = font.loca[gid+1] - font.loca[gid];

			if(len == 0) {
				glyfParts.push(new Uint8Array(0));
				continue;
			}

			// Copy raw bytes; composite glyph component indices must be patched.
			var bytes = new Uint8Array(len);
			for(var j=0; j<len; j++) bytes[j] = data[offset+j];

			scanComposite(bytes, 0, function(pos, glyphIndex) {
				var newGid = old2new[glyphIndex];
				if(newGid === undefined) newGid = 0; // Should not happen, dependencies were added
				bytes[pos]   = (newGid>>8)&0xff;
				bytes[pos+1] = newGid&0xff;
			});

			glyfParts.push(bytes);
			size += len;

			// loca format 0 stores offset/2, so offsets must stay even.
			if(size % 2 != 0) {
				size++;
				// We'll handle padding during concatenation
			}
		}
		loca.push(size);

		// Determine loca format
		var isLongLoca = size > 131070; // 0xFFFF * 2

		// Create glyf buffer
		var glyfBuf = new Uint8Array(size);
		var ptr = 0;
		for(var i=0; i<glyfParts.length; i++) {
			var part = glyfParts[i];
			glyfBuf.set(part, ptr);
			ptr += part.length;
			if(ptr % 2 != 0) ptr++; // Padding
		}

		// Create loca buffer
		var locaBuf;
		if(isLongLoca) {
			locaBuf = new ArrayBuffer(loca.length * 4);
			var view = new DataView(locaBuf);
			for(var i=0; i<loca.length; i++) view.setUint32(i*4, loca[i]);
		} else {
			locaBuf = new ArrayBuffer(loca.length * 2);
			var view = new DataView(locaBuf);
			for(var i=0; i<loca.length; i++) view.setUint16(i*2, loca[i]/2);
		}

		return {
			glyf: new DataView(glyfBuf.buffer),
			loca: new DataView(locaBuf),
			isLongLoca: isLongLoca
		};
	}

	// ------------------------------------------------------------------
	// CFF (OTF) fonts: keep original glyph order/count (renumbering would
	// desynchronize cmap from the CFF CharStrings). The font is shrunk by
	// replacing unused charstrings with a minimal "endchar", which
	// compresses to almost nothing in WOFF/WOFF2.
	// ------------------------------------------------------------------

	function writeCFF(font, chars, isCFF2) {
		var numGlyphs = font.maxp.numGlyphs;

		// Which original glyph ids to keep
		var keep = new Uint8Array(numGlyphs);
		keep[0] = 1; // .notdef
		var charToGlyph = {};

		for(var i=0; i<chars.length; i++) {
			var code = chars.codePointAt(i);
			if(code>0xffff) i++;
			var gid = Typr.U.codeToGlyph(font, code);
			if(gid != 0 && gid < numGlyphs) {
				keep[gid] = 1;
				charToGlyph[code] = gid; // original gid, no renumbering
			}
		}

		// seac (accented character) dependencies: kept glyphs may reference
		// other glyphs from their charstrings. If anything about the
		// charstrings cannot be understood, keep all glyphs (always valid).
		if(!isCFF2) {
			try {
				addSeacDeps(font["CFF "], keep);
			} catch(e) {
				for(var g=0; g<numGlyphs; g++) keep[g] = 1;
			}
		}

		var tables = {};

		// Glyph ids are unchanged, so all glyph-indexed tables are copied as is.
		tables.head = copyTable(font, "head");
		tables.hhea = copyTable(font, "hhea");
		tables.maxp = copyTable(font, "maxp");
		tables.hmtx = copyTable(font, "hmtx");
		tables["OS/2"] = copyTable(font, "OS/2");
		tables.name = copyTable(font, "name");

		var extraTables = ["cvt ", "fpgm", "prep", "gasp", "VORG"];
		for(var i=0; i<extraTables.length; i++) {
			var t = copyTable(font, extraTables[i]);
			if(t) tables[extraTables[i]] = t;
		}

		tables.post = createPost(font);

		if(isCFF2) {
			// CFF2 charstrings are not rewritten; the table is kept unchanged.
			tables["CFF2"] = copyTable(font, "CFF2");
			var cff1 = copyTable(font, "CFF ");
			if(cff1) tables["CFF "] = cff1;
		} else {
			tables["CFF "] = subsetCFFTable(font, keep);
		}

		tables.cmap = createCmap(charToGlyph);

		return createFont(tables);
	}

	// Walks charstrings of all kept glyphs and marks glyphs referenced via the
	// "seac" form of endchar as kept too. Throws when charstrings cannot be
	// safely interpreted.
	function addSeacDeps(cff, keep) {
		if(!cff || !cff["CharStrings"]) throw "no parsed CFF";

		var queue = [];
		for(var g=0; g<keep.length; g++) if(keep[g]) queue.push(g);

		while(queue.length) {
			var gid = queue.pop();
			var cs = cff["CharStrings"][gid];
			if(!cs || cs.length == 0) continue;

			var pdct = cff["Private"] || {};
			if(cff["ROS"]) {
				var gi = 0;
				while(cff["FDSelect"][gi+2] <= gid) gi += 2;
				pdct = cff["FDArray"][cff["FDSelect"][gi+1]]["Private"] || {};
			}

			var deps = [];
			var state = { stack: [], nStems: 0, steps: 0 };
			runCharString(cs, state, cff, pdct, deps, 0);

			for(var i=0; i<deps.length; i++) {
				var dep = deps[i];
				if(dep > 0 && dep < keep.length && !keep[dep]) {
					keep[dep] = 1;
					queue.push(dep);
				}
			}
		}
	}

	// Minimal Type2 charstring interpreter: tracks the operand stack and
	// follows subroutine calls, only to find "endchar" with seac arguments.
	// Returns true when endchar was reached.
	function runCharString(code, st, cff, pdct, deps, depth) {
		if(depth > 10) throw "subr depth";
		var bin = Typr["B"];
		var i = 0;
		while(i < code.length) {
			if(++st.steps > 1000000) throw "too many steps";
			var b0 = code[i];

			if(b0 == 28) { st.stack.push(bin.readShort(code, i+1)); i += 3; }
			else if(b0 == 255) { st.stack.push(bin.readInt(code, i+1)/0x10000); i += 5; }
			else if(b0 >= 32 && b0 <= 246) { st.stack.push(b0-139); i++; }
			else if(b0 >= 247 && b0 <= 250) { st.stack.push((b0-247)*256 + code[i+1] + 108); i += 2; }
			else if(b0 >= 251 && b0 <= 254) { st.stack.push(-(b0-251)*256 - code[i+1] - 108); i += 2; }
			else if(b0 == 19 || b0 == 20) { // hintmask, cntrmask
				st.nStems += st.stack.length >> 1;
				st.stack.length = 0;
				i += 1 + ((st.nStems+7)>>3);
			}
			else if(b0 == 1 || b0 == 3 || b0 == 18 || b0 == 23) { // stems
				st.nStems += st.stack.length >> 1;
				st.stack.length = 0;
				i++;
			}
			else if(b0 == 10 || b0 == 29) { // callsubr, callgsubr
				var obj = (b0 == 10) ? pdct : cff;
				if(!obj["Subrs"]) throw "no subrs";
				var ind = st.stack.pop() + obj["Bias"];
				var subr = obj["Subrs"][ind];
				if(!subr) throw "bad subr index";
				i++;
				if(runCharString(subr, st, cff, pdct, deps, depth+1)) return true;
			}
			else if(b0 == 11) { i++; return false; } // return
			else if(b0 == 14) { // endchar
				var s = st.stack;
				if(s.length == 4 || s.length == 5) { // seac (possibly preceded by width)
					var achar = s.pop(), bchar = s.pop();
					var CFFT = Typr["T"].CFF;
					var bind = CFFT.glyphBySE(cff, bchar);
					var aind = CFFT.glyphBySE(cff, achar);
					if(bind > 0) deps.push(bind);
					if(aind > 0) deps.push(aind);
				}
				return true;
			}
			else if(b0 == 12) { st.stack.length = 0; i += 2; } // escaped operators
			else { st.stack.length = 0; i++; } // all other operators
		}
		return false;
	}

	// Rewrites the CharStrings INDEX inside the raw CFF table, replacing
	// charstrings of removed glyphs with a single "endchar". The table keeps
	// its exact size and layout (the freed space is zero-filled), so no other
	// offset inside the CFF has to be adjusted. Zero padding compresses to
	// almost nothing in WOFF/WOFF2. Falls back to the unchanged table
	// whenever the structure is not fully understood.
	function subsetCFFTable(font, keep) {
		var raw = copyTableBytes(font, "CFF ");
		try {
			var patched = blankCFFCharStrings(raw, keep);
			if(patched) return new DataView(patched.buffer);
		} catch(e) {}
		return new DataView(raw.buffer);
	}

	function blankCFFCharStrings(u8, keep) {
		function readOffN(p, n) {
			var v = 0;
			for(var i=0; i<n; i++) v = (v*256) + u8[p+i];
			return v;
		}
		function indexEnd(off) { // start of whatever follows the INDEX at off
			var count = (u8[off]<<8) | u8[off+1];
			if(count == 0) return off + 2;
			var offSize = u8[off+2];
			if(offSize < 1 || offSize > 4) throw "bad offSize";
			var p = off + 3;
			var dataStart = p + (count+1)*offSize - 1; // offsets are 1-based
			return dataStart + readOffN(p + count*offSize, offSize);
		}

		var hdrSize = u8[2];
		var off = hdrSize;
		off = indexEnd(off); // Name INDEX

		// Top DICT INDEX: find the first entry
		var tdCount = (u8[off]<<8) | u8[off+1];
		if(tdCount < 1) throw "no top dict";
		var tdOffSize = u8[off+2];
		if(tdOffSize < 1 || tdOffSize > 4) throw "bad offSize";
		var tdP = off + 3;
		var tdDataStart = tdP + (tdCount+1)*tdOffSize - 1;
		var tdStart = tdDataStart + readOffN(tdP, tdOffSize);
		var tdEnd   = tdDataStart + readOffN(tdP + tdOffSize, tdOffSize);

		// Parse the Top DICT to find the CharStrings offset (operator 17)
		var csOff = -1;
		var operands = [];
		var p = tdStart;
		while(p < tdEnd) {
			var b0 = u8[p];
			if(b0 <= 21) { // operator
				var op = b0;
				p++;
				if(b0 == 12) { op = 1200 + u8[p]; p++; }
				if(op == 17) csOff = operands[operands.length-1];
				operands = [];
			}
			else if(b0 == 28) { operands.push(((((u8[p+1]<<8)|u8[p+2])<<16)>>16)); p += 3; }
			else if(b0 == 29) { operands.push((u8[p+1]<<24)|(u8[p+2]<<16)|(u8[p+3]<<8)|u8[p+4]); p += 5; }
			else if(b0 == 30) { // real number: nibbles, terminated by 0xF
				p++;
				while(p < tdEnd) { var nb = u8[p]; p++; if((nb&0x0f)==0x0f || (nb>>4)==0x0f) break; }
				operands.push(0);
			}
			else if(b0 >= 32 && b0 <= 246) { operands.push(b0-139); p++; }
			else if(b0 >= 247 && b0 <= 250) { operands.push((b0-247)*256 + u8[p+1] + 108); p += 2; }
			else if(b0 >= 251 && b0 <= 254) { operands.push(-(b0-251)*256 - u8[p+1] - 108); p += 2; }
			else throw "bad dict token";
		}
		if(csOff == null || csOff <= 0 || csOff >= u8.length) throw "no CharStrings";

		// Parse the CharStrings INDEX
		var count = (u8[csOff]<<8) | u8[csOff+1];
		if(count == 0) return null; // nothing to do
		if(count != keep.length) throw "CharStrings count != numGlyphs";
		var offSize = u8[csOff+2];
		if(offSize < 1 || offSize > 4) throw "bad offSize";
		var op0 = csOff + 3;
		var dataStart = op0 + (count+1)*offSize - 1;
		var offs = [];
		for(var i=0; i<=count; i++) offs.push(readOffN(op0 + i*offSize, offSize));
		for(var i=0; i<count; i++) if(offs[i+1] < offs[i]) throw "bad offsets";
		var csEnd = dataStart + offs[count];
		if(csEnd > u8.length) throw "CharStrings out of bounds";
		var oldLen = csEnd - csOff;

		// Build the new INDEX
		var newOffs = [1];
		var dataLen = 0;
		for(var i=0; i<count; i++) {
			var len = offs[i+1] - offs[i];
			if(!keep[i] && len > 1) len = 1; // endchar
			dataLen += len;
			newOffs.push(dataLen + 1);
		}
		var newOffSize = 1;
		if(dataLen+1 > 0xff) newOffSize = 2;
		if(dataLen+1 > 0xffff) newOffSize = 3;
		if(dataLen+1 > 0xffffff) newOffSize = 4;
		var newLen = 3 + (count+1)*newOffSize + dataLen;
		if(newLen > oldLen) return null; // cannot grow; keep the table unchanged

		var out = new Uint8Array(u8.length);
		out.set(u8);
		for(var i=csOff; i<csEnd; i++) out[i] = 0;

		out[csOff]   = (count>>8)&0xff;
		out[csOff+1] = count&0xff;
		out[csOff+2] = newOffSize;
		var q = csOff + 3;
		for(var i=0; i<=count; i++) {
			var v = newOffs[i];
			for(var j=newOffSize-1; j>=0; j--) { out[q+j] = v&0xff; v = Math.floor(v/256); }
			q += newOffSize;
		}
		var newDataStart = csOff + 3 + (count+1)*newOffSize - 1;
		for(var i=0; i<count; i++) {
			var dst = newDataStart + newOffs[i];
			var len = newOffs[i+1] - newOffs[i];
			if(keep[i]) {
				var src = dataStart + offs[i];
				for(var j=0; j<len; j++) out[dst+j] = u8[src+j];
			} else if(len == 1) {
				out[dst] = 14; // endchar
			}
			// len == 0: originally empty charstring, stays empty
		}

		return out;
	}

	// ------------------------------------------------------------------
	// cmap
	// ------------------------------------------------------------------

	function createCmap(charToGlyph) {
		var chars = Object.keys(charToGlyph).map(Number).sort(function(a,b){return a-b});

		// Format 4 covers the BMP; Format 12 is added when needed for chars > 0xFFFF.
		var needFormat12 = chars.length > 0 && chars[chars.length-1] > 0xFFFF;

		var bmpChars = [];
		for(var i=0; i<chars.length; i++) if(chars[i] < 0xFFFF) bmpChars.push(chars[i]);

		var subtables = []; // {platform, encoding, data(Uint8Array)}
		subtables.push({p:3, e:1, data: createCmapFormat4(bmpChars, charToGlyph)});
		if(needFormat12) subtables.push({p:3, e:10, data: createCmapFormat12(chars, charToGlyph)});

		// Assemble the cmap table: header + encoding records + subtables
		var headerLen = 4 + subtables.length*8;
		var total = headerLen;
		for(var i=0; i<subtables.length; i++) total += subtables[i].data.length;

		var cmapBuf = new ArrayBuffer(total);
		var cmapView = new DataView(cmapBuf);
		var cmapBytes = new Uint8Array(cmapBuf);

		cmapView.setUint16(0, 0); // Version
		cmapView.setUint16(2, subtables.length); // NumTables

		var offset = headerLen;
		for(var i=0; i<subtables.length; i++) {
			cmapView.setUint16(4 + i*8, subtables[i].p);
			cmapView.setUint16(6 + i*8, subtables[i].e);
			cmapView.setUint32(8 + i*8, offset);
			cmapBytes.set(subtables[i].data, offset);
			offset += subtables[i].data.length;
		}

		return new DataView(cmapBuf);
	}

	function createCmapFormat4(chars, charToGlyph) {
		var segCount = 0;
		var startCount = [];
		var endCount = [];
		var idDelta = [];
		var idRangeOffset = [];

		if(chars.length > 0) {
			var start = chars[0];
			var end = chars[0];

			// Simple segmentation: continuous ranges where delta is constant
			for(var i=1; i<chars.length; i++) {
				var c = chars[i];
				var gid = charToGlyph[c];
				var prevC = chars[i-1];
				var prevGid = charToGlyph[prevC];

				if(c == prevC + 1 && gid == prevGid + 1) {
					end = c;
				} else {
					startCount.push(start);
					endCount.push(end);
					segCount++;
					start = c;
					end = c;
				}
			}
			startCount.push(start);
			endCount.push(end);
			segCount++;
		}

		// Add end segment
		startCount.push(0xFFFF);
		endCount.push(0xFFFF);
		segCount++;

		var segCountX2 = segCount * 2;
		var searchRange = 2 * Math.pow(2, Math.floor(Math.log(segCount)/Math.log(2)));
		var entrySelector = Math.floor(Math.log(segCount)/Math.log(2));
		var rangeShift = segCountX2 - searchRange;

		// Calculate deltas
		for(var i=0; i<segCount; i++) {
			var start = startCount[i];

			if(start == 0xFFFF) {
				idDelta.push(1);
				idRangeOffset.push(0);
				continue;
			}

			var gidStart = charToGlyph[start];
			var delta = gidStart - start;

			idDelta.push(delta);
			idRangeOffset.push(0);
		}

		// Serialize
		var length = 16 + segCount*8; // Header + arrays
		var buf = new ArrayBuffer(length);
		var view = new DataView(buf);

		view.setUint16(0, 4); // Format
		view.setUint16(2, length);
		view.setUint16(4, 0); // Language
		view.setUint16(6, segCountX2);
		view.setUint16(8, searchRange);
		view.setUint16(10, entrySelector);
		view.setUint16(12, rangeShift);

		var offset = 14;
		for(var i=0; i<segCount; i++) { view.setUint16(offset, endCount[i]); offset+=2; }
		view.setUint16(offset, 0); offset+=2; // ReservedPad
		for(var i=0; i<segCount; i++) { view.setUint16(offset, startCount[i]); offset+=2; }
		for(var i=0; i<segCount; i++) { view.setUint16(offset, idDelta[i]); offset+=2; }
		for(var i=0; i<segCount; i++) { view.setUint16(offset, idRangeOffset[i]); offset+=2; }

		return new Uint8Array(buf);
	}

	function createCmapFormat12(chars, charToGlyph) {
		// Format 12: Segmented coverage
		var groups = [];

		if(chars.length > 0) {
			var start = chars[0];
			var end = chars[0];
			var startGid = charToGlyph[start];

			for(var i=1; i<chars.length; i++) {
				var c = chars[i];
				var gid = charToGlyph[c];
				var prevC = chars[i-1];
				var prevGid = charToGlyph[prevC];

				if(c == prevC + 1 && gid == prevGid + 1) {
					end = c;
				} else {
					groups.push({start: start, end: end, startGid: startGid});
					start = c;
					end = c;
					startGid = gid;
				}
			}
			groups.push({start: start, end: end, startGid: startGid});
		}

		var numGroups = groups.length;
		var length = 16 + numGroups * 12;
		var buf = new ArrayBuffer(length);
		var view = new DataView(buf);

		view.setUint16(0, 12); // Format
		view.setUint16(2, 0); // Reserved
		view.setUint32(4, length);
		view.setUint32(8, 0); // Language
		view.setUint32(12, numGroups);

		var offset = 16;
		for(var i=0; i<numGroups; i++) {
			view.setUint32(offset, groups[i].start); offset+=4;
			view.setUint32(offset, groups[i].end); offset+=4;
			view.setUint32(offset, groups[i].startGid); offset+=4;
		}

		return new Uint8Array(buf);
	}

	function createPost(font) {
		var buf = new ArrayBuffer(32);
		var view = new DataView(buf);

		var post = font.post || {};

		view.setUint32(0, 0x00030000); // Version 3.0

		// italicAngle
		var italicAngle = post.italicAngle || 0;
		// Convert float to Fixed (16.16)
		var mantissa = Math.floor(italicAngle);
		var fraction = Math.floor((italicAngle - mantissa) * 65536);
		view.setInt16(4, mantissa);
		view.setUint16(6, fraction);

		view.setInt16(8, post.underlinePosition || 0);
		view.setInt16(10, post.underlineThickness || 0);

		view.setUint32(12, post.isFixedPitch || 0);

		// Memory usage fields (set to 0)
		view.setUint32(16, 0);
		view.setUint32(20, 0);
		view.setUint32(24, 0);
		view.setUint32(28, 0);

		return view;
	}

	function createFont(tables) {
		var tableTags = Object.keys(tables);
		var numTables = tableTags.length;

		// Calculate offsets
		var headerSize = 12 + numTables * 16;
		var offset = headerSize;
		var tableRecords = [];

		// Sort tags
		tableTags.sort();

		for(var i=0; i<numTables; i++) {
			var tag = tableTags[i];
			var data = tables[tag];
			if(!data) continue;

			var len = data.byteLength;
			var padding = (4 - (len % 4)) % 4;

			// Checksum
			var checksum = calcChecksum(data);

			tableRecords.push({
				tag: tag,
				checksum: checksum,
				offset: offset,
				length: len,
				padding: padding,
				data: data
			});

			offset += len + padding;
		}

		var totalSize = offset;
		var buf = new ArrayBuffer(totalSize);
		var view = new DataView(buf);

		// Header
		var isCFF = tables["CFF "] != null || tables["CFF2"] != null;
		view.setUint32(0, isCFF ? 0x4F54544F : 0x00010000); // OTTO or \x00\x01\x00\x00
		view.setUint16(4, numTables);

		var searchRange = 16 * Math.pow(2, Math.floor(Math.log(numTables)/Math.log(2)));
		view.setUint16(6, searchRange);
		view.setUint16(8, Math.floor(Math.log(numTables)/Math.log(2)));
		view.setUint16(10, numTables * 16 - searchRange);

		// Table Records
		var recOffset = 12;
		for(var i=0; i<tableRecords.length; i++) {
			var rec = tableRecords[i];
			writeTag(view, recOffset, rec.tag);
			view.setUint32(recOffset+4, rec.checksum);
			view.setUint32(recOffset+8, rec.offset);
			view.setUint32(recOffset+12, rec.length);
			recOffset += 16;
		}

		// Table Data
		var bytes = new Uint8Array(buf);
		for(var i=0; i<tableRecords.length; i++) {
			var rec = tableRecords[i];
			var dataBytes = new Uint8Array(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength);
			bytes.set(dataBytes, rec.offset);
			// Padding is zero by default
		}

		// Calc full checksum (head table adjustment)
		var headRec = tableRecords.find(r => r.tag == "head");
		if(headRec) {
			var headOffset = headRec.offset;
			view.setUint32(headOffset + 8, 0); // checkSumAdjustment is at offset 8 in head

			// Recalculate head table checksum
			var headData = new DataView(buf, headOffset, headRec.length);
			var newHeadChecksum = calcChecksum(headData);

			// Update head record checksum
			var headRecIdx = tableTags.indexOf("head");
			view.setUint32(12 + headRecIdx*16 + 4, newHeadChecksum);

			// Calculate whole font checksum
			var wholeChecksum = calcChecksum(new DataView(buf));
			var adjustment = (0xB1B0AFBA - wholeChecksum) >>> 0;

			// Write adjustment
			view.setUint32(headOffset + 8, adjustment);
		}

		return buf;
	}

	function calcChecksum(data) {
		var sum = 0;
		var len = data.byteLength;
		for(var i=0; i<len; i+=4) {
			// Treat as uint32
			if(i + 4 <= len) {
				sum = (sum + data.getUint32(i)) >>> 0;
			} else {
				// Handle remaining bytes
				var v = 0;
				v |= data.getUint8(i) << 24;
				if(i+1 < len) v |= data.getUint8(i+1) << 16;
				if(i+2 < len) v |= data.getUint8(i+2) << 8;
				sum = (sum + v) >>> 0;
			}
		}
		return sum;
	}

	function writeTag(view, offset, tag) {
		for(var i=0; i<4; i++) view.setUint8(offset+i, tag.charCodeAt(i));
	}

	return { write: write };
})();
