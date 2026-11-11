"""
PDF Field Annotator
-------------------
Draw named bounding boxes over PDF content to define ROI extraction fields,
and run single-PDF or bulk-ZIP extraction against a persisted field schema.

REFERENCE IMPLEMENTATION — NOT PRODUCTION CODE.
This file lives under analysis/reference/ to make its status unambiguous.
Do not import it from the app; do not bundle it.

Usage:
    python pdf_annotator.py [optional_path_to_pdf]

Controls (Annotate tab):
    - Left click + drag  : draw a new box (then name it)
    - Left click on box  : select it
    - Right click on box : delete it
    - Ctrl + Wheel       : zoom in / out
    - Shift + Wheel      : horizontal scroll
    - Mouse wheel        : vertical scroll
    - PageUp / PageDown  : scroll one page
    - Home / End         : scroll to top / bottom
    - Left / Right arrow : previous / next PDF page
    - S : save annotations
    - L : load annotations
    - E : export field schema
    - Ctrl+0 : reset zoom to 100%
    - Ctrl+plus / Ctrl+minus : zoom in / out

Tabs:
    Annotate  — draw and name ROI boxes on a blank form
    Extract   — apply a schema to a single filled PDF
    Bulk      — process ZIPs, per-file schema assignment, skip unassigned
"""

import json
import os
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk
from dataclasses import dataclass, asdict, field
from typing import Dict, List, Optional, Tuple

import fitz  # PyMuPDF
from PIL import Image, ImageTk


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class FieldBox:
    """A single named ROI rectangle, stored in PDF points."""
    name: str
    page: int                 # 0-based
    x0: float                 # PDF points, origin top-left
    y0: float
    x1: float
    y1: float

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class AnnotationDocument:
    pdf_path: str = ""
    fields: List[FieldBox] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "pdf_path": self.pdf_path,
            "coordinate_system": "PDF points, origin top-left",
            "fields": [f.to_dict() for f in self.fields],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "AnnotationDocument":
        return cls(
            pdf_path=data.get("pdf_path", ""),
            fields=[FieldBox(**f) for f in data.get("fields", [])],
        )


# ---------------------------------------------------------------------------
# Annotator GUI
# ---------------------------------------------------------------------------

class PDFAnnotator:
    RENDER_DPI = 120                     # default base DPI
    BOX_COLOR = "#FF3B30"
    SEL_COLOR = "#34C759"
    ZOOM_MIN = 0.25
    ZOOM_MAX = 4.0
    ZOOM_STEP = 1.25

    def __init__(self, root: tk.Tk, pdf_path: Optional[str] = None):
        self.root = root
        self.root.title("PDF Field Annotator")
        self.root.geometry("1200x900")

        # PDF state
        self.doc: Optional[fitz.Document] = None
        self.current_page = 0

        # Zoom state
        self.base_dpi = self.RENDER_DPI
        self.zoom_factor = 1.0
        self.zoom = (self.base_dpi * self.zoom_factor) / 72.0
        self._last_zoom = self.zoom
        self.tk_image: Optional[ImageTk.PhotoImage] = None

        # Annotations
        self.annotations = AnnotationDocument()
        self.selected_index: Optional[int] = None

        # Drag state
        self.drag_start: Optional[Tuple[float, float]] = None   # canvas coords
        self.drag_rect_id: Optional[int] = None

        # Single-PDF extraction state
        self._schema: Optional[dict] = None
        self._schema_path: Optional[str] = None
        self._filled_pdf_path: Optional[str] = None
        self._last_results: Optional[dict] = None

        # Multi-schema + bulk state
        self._schemas: Dict[str, dict] = {}
        self._schema_paths: Dict[str, str] = {}
        self._bulk_zip_paths: List[str] = []
        self._bulk_entries: List[dict] = []
        self._bulk_assignments: Dict[str, Optional[str]] = {}
        self._bulk_report = None

        self._build_ui()
        self._bind_keys()

        if pdf_path and os.path.isfile(pdf_path):
            self.load_pdf(pdf_path)

    # ------------------------------------------------------------------ UI --
    def _build_ui(self):
        toolbar = tk.Frame(self.root, bd=1, relief=tk.RAISED)
        toolbar.pack(side=tk.TOP, fill=tk.X)

        tk.Button(toolbar, text="Open PDF…",
                  command=self.on_open_pdf).pack(side=tk.LEFT, padx=4, pady=4)

        tk.Label(toolbar, text=" | ").pack(side=tk.LEFT)
        tk.Button(toolbar, text="◀ Prev", command=self.prev_page).pack(
            side=tk.LEFT, padx=2)
        self.page_label = tk.Label(toolbar, text="Page - / -")
        self.page_label.pack(side=tk.LEFT, padx=8)
        tk.Button(toolbar, text="Next ▶", command=self.next_page).pack(
            side=tk.LEFT, padx=2)

        tk.Label(toolbar, text=" | ").pack(side=tk.LEFT)
        tk.Button(toolbar, text="Zoom −", width=7,
                  command=lambda: self.zoom_by(1 / self.ZOOM_STEP)).pack(side=tk.LEFT, padx=2)
        self.zoom_lbl = tk.Label(toolbar, text="100%", width=6)
        self.zoom_lbl.pack(side=tk.LEFT)
        tk.Button(toolbar, text="Zoom +", width=7,
                  command=lambda: self.zoom_by(self.ZOOM_STEP)).pack(side=tk.LEFT, padx=2)
        tk.Button(toolbar, text="Fit",
                  command=self.zoom_to_fit).pack(side=tk.LEFT, padx=(4, 0))
        tk.Button(toolbar, text="100%",
                  command=self.zoom_reset).pack(side=tk.LEFT, padx=(2, 0))

        tk.Label(toolbar, text=" | ").pack(side=tk.LEFT)
        tk.Button(toolbar, text="Save (S)", command=self.on_save).pack(
            side=tk.LEFT, padx=2)
        tk.Button(toolbar, text="Load (L)", command=self.on_load).pack(
            side=tk.LEFT, padx=2)
        tk.Button(toolbar, text="Export Schema (E)",
                  command=self.on_export).pack(side=tk.LEFT, padx=2)

        # Tabs
        self.notebook = ttk.Notebook(self.root)
        self.notebook.pack(side=tk.TOP, fill=tk.BOTH, expand=True)

        annotate_tab = tk.Frame(self.notebook)
        extract_tab = tk.Frame(self.notebook)
        bulk_tab = tk.Frame(self.notebook)
        self.notebook.add(annotate_tab, text="Annotate")
        self.notebook.add(extract_tab, text="Extract")
        self.notebook.add(bulk_tab, text="Bulk")

        self._build_annotate_tab(annotate_tab)
        self._build_extract_tab(extract_tab)
        self._build_bulk_tab(bulk_tab)

        self.status = tk.Label(self.root, text="Ready.", anchor="w",
                               bd=1, relief=tk.SUNKEN)
        self.status.pack(side=tk.BOTTOM, fill=tk.X)

    def _build_annotate_tab(self, parent: tk.Frame):
        body = tk.Frame(parent)
        body.pack(side=tk.TOP, fill=tk.BOTH, expand=True)

        canvas_container = tk.Frame(body)
        canvas_container.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        canvas_container.grid_rowconfigure(0, weight=1)
        canvas_container.grid_columnconfigure(0, weight=1)

        self.canvas = tk.Canvas(canvas_container, bg="#888888", cursor="cross")
        self.canvas.grid(row=0, column=0, sticky="nsew")

        self.vbar = tk.Scrollbar(canvas_container, orient=tk.VERTICAL,
                                 command=self.canvas.yview)
        self.vbar.grid(row=0, column=1, sticky="ns")
        self.hbar = tk.Scrollbar(canvas_container, orient=tk.HORIZONTAL,
                                 command=self.canvas.xview)
        self.hbar.grid(row=1, column=0, sticky="ew")
        self.canvas.configure(yscrollcommand=self.vbar.set,
                              xscrollcommand=self.hbar.set)

        side = tk.Frame(body, width=260, bd=1, relief=tk.SUNKEN)
        side.pack(side=tk.RIGHT, fill=tk.Y)
        side.pack_propagate(False)

        tk.Label(side, text="Fields on this page",
                 font=("TkDefaultFont", 10, "bold")).pack(anchor="w", padx=6, pady=(6, 2))
        self.field_list = tk.Listbox(side, exportselection=False)
        self.field_list.pack(fill=tk.BOTH, expand=True, padx=6, pady=4)
        self.field_list.bind("<<ListboxSelect>>", self.on_list_select)

        tk.Button(side, text="Delete Selected",
                  command=self.delete_selected).pack(fill=tk.X, padx=6, pady=(0, 6))

        self.canvas.bind("<ButtonPress-1>", self.on_mouse_down)
        self.canvas.bind("<B1-Motion>", self.on_mouse_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_mouse_up)
        self.canvas.bind("<Button-3>", self.on_right_click)

    def _build_extract_tab(self, parent: tk.Frame):
        frm = tk.Frame(parent)
        frm.pack(fill=tk.X, padx=8, pady=8)

        self.schema_path_var = tk.StringVar(value="(no schema loaded)")
        self.filled_pdf_var = tk.StringVar(value="(no filled PDF selected)")

        tk.Label(frm, text="Field schema:").grid(row=0, column=0, sticky="w")
        tk.Entry(frm, textvariable=self.schema_path_var, width=70,
                 state="readonly").grid(row=0, column=1, sticky="we", padx=4)
        tk.Button(frm, text="Load Schema…",
                  command=self.on_load_schema).grid(row=0, column=2)

        tk.Label(frm, text="Filled PDF:").grid(
            row=1, column=0, sticky="w", pady=(6, 0))
        tk.Entry(frm, textvariable=self.filled_pdf_var, width=70,
                 state="readonly").grid(row=1, column=1, sticky="we", padx=4, pady=(6, 0))
        tk.Button(frm, text="Choose PDF…",
                  command=self.on_choose_filled_pdf).grid(row=1, column=2, pady=(6, 0))

        tk.Button(frm, text="▶ Extract Values", bg="#0A84FF", fg="white",
                  font=("TkDefaultFont", 10, "bold"),
                  command=self.on_run_extraction).grid(
            row=2, column=0, columnspan=3, pady=12, sticky="we")

        frm.grid_columnconfigure(1, weight=1)

        cols = ("field", "value", "confidence", "source")
        self.result_tree = ttk.Treeview(
            parent, columns=cols, show="headings", height=18)
        for c, w in zip(cols, (220, 380, 90, 100)):
            self.result_tree.heading(c, text=c.capitalize())
            self.result_tree.column(c, width=w, anchor="w")
        self.result_tree.pack(fill=tk.BOTH, expand=True, padx=8, pady=(0, 8))
        self.result_tree.tag_configure("low", background="#FFF3CD")
        self.result_tree.tag_configure("high", background="#D1F7D6")

        self.extract_export_btn = tk.Button(
            parent, text="Export Extracted JSON…", state=tk.DISABLED,
            command=self.on_export_extracted)
        self.extract_export_btn.pack(fill=tk.X, padx=8, pady=(0, 8))

    def _build_bulk_tab(self, parent: tk.Frame):
        top = tk.Frame(parent)
        top.pack(fill=tk.X, padx=8, pady=8)

        self.zip_list_var = tk.StringVar(value="(no ZIP files selected)")
        tk.Label(top, text="ZIP files:").grid(row=0, column=0, sticky="nw")
        tk.Entry(top, textvariable=self.zip_list_var, width=60,
                 state="readonly").grid(row=0, column=1, sticky="we", padx=4)
        tk.Button(top, text="Add ZIPs…",
                  command=self.on_bulk_pick_zips).grid(row=0, column=2)
        tk.Button(top, text="Clear",
                  command=self.on_bulk_clear_zips).grid(row=0, column=3, padx=(4, 0))

        self.schemas_list_var = tk.StringVar(value="(no schemas loaded)")
        tk.Label(top, text="Schemas:").grid(
            row=1, column=0, sticky="w", pady=(6, 0))
        tk.Entry(top, textvariable=self.schemas_list_var, width=60,
                 state="readonly").grid(row=1, column=1, sticky="we", padx=4, pady=(6, 0))
        tk.Button(top, text="Add Schemas…",
                  command=self.on_bulk_add_schemas).grid(row=1, column=2, pady=(6, 0))
        tk.Button(top, text="Clear",
                  command=self.on_bulk_clear_schemas).grid(row=1, column=3,
                                                           padx=(4, 0), pady=(6, 0))

        stage1 = tk.Frame(top)
        stage1.grid(row=2, column=0, columnspan=4, pady=(10, 0), sticky="we")
        tk.Button(stage1, text="① Scan ZIPs", bg="#0A84FF", fg="white",
                  font=("TkDefaultFont", 10, "bold"),
                  command=self.on_bulk_scan).pack(side=tk.LEFT, fill=tk.X, expand=True)
        tk.Button(stage1, text="② Extract Assigned", bg="#34C759", fg="white",
                  font=("TkDefaultFont", 10, "bold"),
                  command=self.on_bulk_extract).pack(side=tk.LEFT, fill=tk.X,
                                                     expand=True, padx=(8, 0))
        top.grid_columnconfigure(1, weight=1)

        mid = tk.Frame(parent)
        mid.pack(fill=tk.X, padx=8, pady=(4, 4))
        tk.Label(mid, text="Assign schema per PDF (unassigned rows are skipped):",
                 anchor="w").pack(fill=tk.X)

        helpers = tk.Frame(mid)
        helpers.pack(fill=tk.X, pady=(4, 0))
        tk.Label(helpers, text="Bulk assign selected rows to:",
                 anchor="w").pack(side=tk.LEFT)
        self.bulk_assign_var = tk.StringVar()
        self.bulk_assign_combo = ttk.Combobox(helpers, textvariable=self.bulk_assign_var,
                                              state="readonly", width=30)
        self.bulk_assign_combo.pack(side=tk.LEFT, padx=4)
        tk.Button(helpers, text="Apply to selected",
                  command=self.on_bulk_apply_to_selected).pack(side=tk.LEFT)
        tk.Button(helpers, text="Clear assignment",
                  command=self.on_bulk_clear_assignment).pack(side=tk.LEFT, padx=(8, 0))

        cols = ("archive", "relative_path", "schema", "size_kb", "status")
        self.bulk_tree = ttk.Treeview(parent, columns=cols, show="headings",
                                      height=14, selectmode="extended")
        for c, w in zip(cols, (140, 340, 160, 70, 120)):
            self.bulk_tree.heading(c, text=c.capitalize())
            self.bulk_tree.column(c, width=w, anchor="w")
        self.bulk_tree.pack(fill=tk.BOTH, expand=True, padx=8, pady=(4, 4))
        self.bulk_tree.bind("<Double-1>", self.on_bulk_row_double_click)
        self.bulk_tree.tag_configure("unassigned", background="#FFF3CD")
        self.bulk_tree.tag_configure("err", background="#FFD6D6")

        self.bulk_progress = ttk.Progressbar(parent, mode="determinate")
        self.bulk_progress.pack(fill=tk.X, padx=8)

        btns = tk.Frame(parent)
        btns.pack(fill=tk.X, padx=8, pady=(4, 8))
        self.bulk_export_btn = tk.Button(btns, text="Export Bulk Results…",
                                         state=tk.DISABLED,
                                         command=self.on_bulk_export)
        self.bulk_export_btn.pack(side=tk.LEFT)
        self.bulk_detail_btn = tk.Button(btns, text="View Selected…",
                                         state=tk.DISABLED,
                                         command=self.on_bulk_view_selected)
        self.bulk_detail_btn.pack(side=tk.LEFT, padx=6)
        self.bulk_summary_lbl = tk.Label(btns, text="", anchor="e")
        self.bulk_summary_lbl.pack(side=tk.RIGHT)

    def _bind_keys(self):
        self.root.bind("<Left>", lambda e: self.prev_page())
        self.root.bind("<Right>", lambda e: self.next_page())
        self.root.bind("<s>", lambda e: self.on_save())
        self.root.bind("<S>", lambda e: self.on_save())
        self.root.bind("<l>", lambda e: self.on_load())
        self.root.bind("<L>", lambda e: self.on_load())
        self.root.bind("<e>", lambda e: self.on_export())
        self.root.bind("<E>", lambda e: self.on_export())
        self.root.bind("<Delete>", lambda e: self.delete_selected())

        # Zoom keybindings
        self.root.bind("<Control-plus>",
                       lambda e: self.zoom_by(self.ZOOM_STEP))
        self.root.bind("<Control-equal>",
                       lambda e: self.zoom_by(self.ZOOM_STEP))
        self.root.bind("<Control-minus>",
                       lambda e: self.zoom_by(1 / self.ZOOM_STEP))
        self.root.bind("<Control-0>", lambda e: self.zoom_reset())

        # Zoom via wheel is bound on canvas; do it in _build_annotate_tab()
        self.canvas.bind("<Control-MouseWheel>", self._on_ctrl_wheel)
        self.canvas.bind("<Control-Button-4>",
                         lambda e: self.zoom_by(self.ZOOM_STEP))
        self.canvas.bind("<Control-Button-5>",
                         lambda e: self.zoom_by(1 / self.ZOOM_STEP))

        # Scroll bindings
        self.canvas.bind("<MouseWheel>", self._on_mousewheel)
        self.canvas.bind("<Button-4>", lambda e: self._scroll_units(-3))
        self.canvas.bind("<Button-5>", lambda e: self._scroll_units(3))
        self.canvas.bind("<Shift-MouseWheel>", self._on_shift_mousewheel)
        self.canvas.bind("<Prior>", lambda e: self._scroll_pages(-1))
        self.canvas.bind("<Next>", lambda e: self._scroll_pages(1))
        self.canvas.bind("<Home>", lambda e: self.canvas.yview_moveto(0))
        self.canvas.bind("<End>", lambda e: self.canvas.yview_moveto(1))
        self.canvas.focus_set()

    # ------------------------------------------------------------- PDF I/O --
    def on_open_pdf(self):
        path = filedialog.askopenfilename(filetypes=[("PDF files", "*.pdf")])
        if path:
            self.load_pdf(path)

    def load_pdf(self, path: str):
        try:
            self.doc = fitz.open(path)
        except Exception as e:
            messagebox.showerror("Open PDF", f"Failed to open PDF:\n{e}")
            return
        self.annotations = AnnotationDocument(pdf_path=path)
        self.current_page = 0
        self.selected_index = None
        self.render_page()
        # Fit page to viewport on first open
        self.root.after_idle(self.zoom_to_fit)
        self.status.config(
            text=f"Loaded {os.path.basename(path)} ({self.doc.page_count} pages)")

    # -------------------------------------------------------------- Render --
    def render_page(self, keep_viewport: bool = False):
        if not self.doc:
            return

        self.zoom = (self.base_dpi * self.zoom_factor) / 72.0

        # Save previous scroll position in *PDF-point* units for restoration.
        prev_zoom = self._last_zoom or self.zoom
        old_x = self.canvas.canvasx(0) / prev_zoom
        old_y = self.canvas.canvasy(0) / prev_zoom

        page = self.doc.load_page(self.current_page)
        pix = page.get_pixmap(matrix=fitz.Matrix(
            self.zoom, self.zoom), alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        self.tk_image = ImageTk.PhotoImage(img)

        self.canvas.delete("all")
        self.canvas.config(scrollregion=(0, 0, pix.width, pix.height))
        self.canvas.create_image(0, 0, anchor="nw", image=self.tk_image)

        if keep_viewport:
            new_x = old_x * self.zoom
            new_y = old_y * self.zoom
            if pix.width > 0:
                self.canvas.xview_moveto(max(0.0, min(1.0, new_x / pix.width)))
            if pix.height > 0:
                self.canvas.yview_moveto(
                    max(0.0, min(1.0, new_y / pix.height)))

        self._last_zoom = self.zoom

        self.redraw_boxes()
        self.refresh_field_list()
        self.page_label.config(
            text=f"Page {self.current_page + 1} / {self.doc.page_count}")

    def _image_origin_canvas(self) -> Tuple[float, float]:
        """Return the canvas-coordinate origin of the rendered image."""
        for item in self.canvas.find_all():
            if self.canvas.type(item) == "image":
                bbox = self.canvas.bbox(item)
                return float(bbox[0]), float(bbox[1])
        return 0.0, 0.0

    def _canvas_to_pdf(self, cx: float, cy: float) -> Tuple[float, float]:
        """Canvas px → PDF points. Single source of truth for the conversion."""
        ix0, iy0 = self._image_origin_canvas()
        return ((cx - ix0) / self.zoom, (cy - iy0) / self.zoom)

    def redraw_boxes(self):
        self.canvas.delete("box")
        self.canvas.delete("boxlabel")
        ix0, iy0 = self._image_origin_canvas()
        for i, fb in enumerate(self.annotations.fields):
            if fb.page != self.current_page:
                continue
            x0 = ix0 + fb.x0 * self.zoom
            y0 = iy0 + fb.y0 * self.zoom
            x1 = ix0 + fb.x1 * self.zoom
            y1 = iy0 + fb.y1 * self.zoom
            color = self.SEL_COLOR if i == self.selected_index else self.BOX_COLOR
            width = 2 if i == self.selected_index else 1
            self.canvas.create_rectangle(x0, y0, x1, y1, outline=color,
                                         width=width, tags=("box", f"field{i}"))
            self.canvas.create_text(x0 + 3, y0 + 3, anchor="nw", text=fb.name,
                                    fill=color,
                                    font=("TkDefaultFont", 9, "bold"),
                                    tags=("boxlabel", f"field{i}"))

    def refresh_field_list(self):
        self.field_list.delete(0, tk.END)
        self._page_field_indices = []
        for i, fb in enumerate(self.annotations.fields):
            if fb.page == self.current_page:
                self.field_list.insert(tk.END, fb.name)
                self._page_field_indices.append(i)
        if self.selected_index in self._page_field_indices:
            pos = self._page_field_indices.index(self.selected_index)
            self.field_list.selection_clear(0, tk.END)
            self.field_list.selection_set(pos)

    # ---------------------------------------------------------- Page nav ----
    def prev_page(self):
        if self.doc and self.current_page > 0:
            self.current_page -= 1
            self.selected_index = None
            self.render_page()
            self.canvas.yview_moveto(0)
            self.canvas.xview_moveto(0)

    def next_page(self):
        if self.doc and self.current_page < self.doc.page_count - 1:
            self.current_page += 1
            self.selected_index = None
            self.render_page()
            self.canvas.yview_moveto(0)
            self.canvas.xview_moveto(0)

    # ----------------------------------------------------------- Zoom -------
    def zoom_by(self, factor: float):
        new_factor = self.zoom_factor * factor
        new_factor = max(self.ZOOM_MIN, min(self.ZOOM_MAX, new_factor))
        if abs(new_factor - self.zoom_factor) < 1e-4:
            return
        self.zoom_factor = new_factor
        self._update_zoom_label()
        self.render_page(keep_viewport=True)

    def zoom_reset(self):
        self.zoom_factor = 1.0
        self._update_zoom_label()
        self.render_page(keep_viewport=False)

    def zoom_to_fit(self):
        if not self.doc:
            return
        page = self.doc.load_page(self.current_page)
        cw = max(self.canvas.winfo_width(), 200) - 20
        ch = max(self.canvas.winfo_height(), 200) - 20
        if cw <= 0 or ch <= 0:
            return
        fit_dpi_w = cw / (page.rect.width / 72.0)
        fit_dpi_h = ch / (page.rect.height / 72.0)
        fit_dpi = min(fit_dpi_w, fit_dpi_h)
        self.zoom_factor = max(
            self.ZOOM_MIN, min(self.ZOOM_MAX, fit_dpi / self.base_dpi))
        self._update_zoom_label()
        self.render_page(keep_viewport=False)

    def _update_zoom_label(self):
        if hasattr(self, "zoom_lbl"):
            self.zoom_lbl.config(text=f"{int(round(self.zoom_factor * 100))}%")

    def _on_ctrl_wheel(self, event):
        if event.delta > 0:
            self.zoom_by(self.ZOOM_STEP)
        elif event.delta < 0:
            self.zoom_by(1 / self.ZOOM_STEP)
        return "break"

    # ---------------------------------------------------------- Scroll ------
    def _on_mousewheel(self, event):
        if event.delta == 0:
            return "break"
        if abs(event.delta) >= 120:
            units = -int(event.delta / 120) * 3
        else:
            units = -int(event.delta) * 3
        self._scroll_units(units)
        return "break"

    def _on_shift_mousewheel(self, event):
        if event.delta == 0:
            return "break"
        if abs(event.delta) >= 120:
            units = -int(event.delta / 120) * 3
        else:
            units = -int(event.delta) * 3
        self.canvas.xview_scroll(units, "units")
        return "break"

    def _scroll_units(self, units: int):
        self.canvas.yview_scroll(units, "units")

    def _scroll_pages(self, direction: int):
        self.canvas.yview_scroll(direction, "pages")

    # --------------------------------------------------- Mouse handlers ----
    def on_mouse_down(self, event):
        if not self.doc:
            return
        cx = self.canvas.canvasx(event.x)
        cy = self.canvas.canvasy(event.y)

        hit = self.hit_test(cx, cy)
        if hit is not None:
            self.selected_index = hit
            self.redraw_boxes()
            self.refresh_field_list()
            self.drag_start = None
            self.status.config(
                text=f"Selected field '{self.annotations.fields[hit].name}'")
            return

        self.selected_index = None
        self.redraw_boxes()
        self.drag_start = (cx, cy)
        self.drag_rect_id = self.canvas.create_rectangle(
            cx, cy, cx, cy,
            outline=self.BOX_COLOR, width=2, dash=(4, 2), tags=("drag",))

    def on_mouse_drag(self, event):
        if not self.drag_start or not self.drag_rect_id:
            return
        cx = self.canvas.canvasx(event.x)
        cy = self.canvas.canvasy(event.y)
        x0, y0 = self.drag_start
        self.canvas.coords(self.drag_rect_id, x0, y0, cx, cy)

    def on_mouse_up(self, event):
        if not self.drag_start or not self.drag_rect_id:
            return

        cx = self.canvas.canvasx(event.x)
        cy = self.canvas.canvasy(event.y)

        x0s, y0s = self.drag_start
        x1s, y1s = cx, cy
        self.canvas.delete(self.drag_rect_id)
        self.drag_rect_id = None
        self.drag_start = None

        if abs(x1s - x0s) < 5 or abs(y1s - y0s) < 5:
            return

        # Convert both canvas corners to PDF points via the single helper.
        pdf_x0, pdf_y0 = self._canvas_to_pdf(x0s, y0s)
        pdf_x1, pdf_y1 = self._canvas_to_pdf(x1s, y1s)
        px0, px1 = sorted((pdf_x0, pdf_x1))
        py0, py1 = sorted((pdf_y0, pdf_y1))

        name = simpledialog.askstring(
            "Field name",
            "Enter a unique field name (e.g. 'invoice_total'):",
            parent=self.root,
        )
        if not name:
            return
        name = name.strip().replace(" ", "_")
        if not name:
            return
        if any(f.name == name for f in self.annotations.fields):
            messagebox.showwarning("Duplicate",
                                   f"A field named '{name}' already exists.")
            return

        fb = FieldBox(name=name, page=self.current_page,
                      x0=px0, y0=py0, x1=px1, y1=py1)
        self.annotations.fields.append(fb)
        self.selected_index = len(self.annotations.fields) - 1
        self.redraw_boxes()
        self.refresh_field_list()
        self.status.config(
            text=f"Added '{name}' on page {self.current_page + 1} "
            f"(x0={px0:.1f}, y0={py0:.1f}, x1={px1:.1f}, y1={py1:.1f})")

    def on_right_click(self, event):
        cx = self.canvas.canvasx(event.x)
        cy = self.canvas.canvasy(event.y)
        hit = self.hit_test(cx, cy)
        if hit is not None:
            name = self.annotations.fields[hit].name
            if messagebox.askyesno("Delete field", f"Delete '{name}'?"):
                self._remove_field(hit)

    def hit_test(self, cx: float, cy: float) -> Optional[int]:
        """`cx`, `cy` are canvas coordinates."""
        px, py = self._canvas_to_pdf(cx, cy)
        for i in reversed(range(len(self.annotations.fields))):
            fb = self.annotations.fields[i]
            if (fb.page == self.current_page
                    and fb.x0 <= px <= fb.x1
                    and fb.y0 <= py <= fb.y1):
                return i
        return None

    # --------------------------------------------------------- Selection ---
    def on_list_select(self, _event):
        sel = self.field_list.curselection()
        if not sel:
            return
        idx = self._page_field_indices[sel[0]]
        self.selected_index = idx
        self.redraw_boxes()

    def delete_selected(self):
        if self.selected_index is None:
            return
        self._remove_field(self.selected_index)

    def _remove_field(self, idx: int):
        if 0 <= idx < len(self.annotations.fields):
            removed = self.annotations.fields.pop(idx)
            self.selected_index = None
            self.redraw_boxes()
            self.refresh_field_list()
            self.status.config(text=f"Deleted '{removed.name}'")

    # ----------------------------------------------------- Save / Load -----
    def on_save(self):
        if not self.annotations.fields:
            messagebox.showinfo("Save", "No fields to save.")
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".json",
            filetypes=[("Annotation JSON", "*.json")],
        )
        if not path:
            return
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.annotations.to_dict(), f, indent=2)
        self.status.config(text=f"Saved annotations to {path}")

    def on_load(self):
        path = filedialog.askopenfilename(
            filetypes=[("Annotation JSON", "*.json")])
        if not path:
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.annotations = AnnotationDocument.from_dict(data)
        except Exception as e:
            messagebox.showerror("Load", f"Failed to load annotations:\n{e}")
            return

        if (self.doc is None and self.annotations.pdf_path
                and os.path.isfile(self.annotations.pdf_path)):
            try:
                self.doc = fitz.open(self.annotations.pdf_path)
            except Exception:
                pass

        self.current_page = 0
        self.selected_index = None
        if self.doc:
            self.render_page()
        self.status.config(
            text=f"Loaded {len(self.annotations.fields)} fields from {path}")

    # --------------------------------------------------------- Export ------
    def on_export(self):
        if not self.doc or not self.annotations.fields:
            messagebox.showinfo("Export",
                                "Open a PDF and add at least one field first.")
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".json",
            filetypes=[("Field schema JSON", "*.json")],
            initialfile="field_schema.json",
        )
        if not path:
            return

        pages: Dict[int, List[dict]] = {}
        for fb in self.annotations.fields:
            if fb.page >= self.doc.page_count:
                continue
            page = self.doc.load_page(fb.page)
            rect = page.rect
            w, h = rect.width, rect.height
            if w <= 0 or h <= 0:
                continue
            pages.setdefault(fb.page, []).append({
                "name": fb.name,
                "bbox_pdf_pt": {"x0": fb.x0, "y0": fb.y0,
                                "x1": fb.x1, "y1": fb.y1},
                "bbox_normalized": {
                    "x0": fb.x0 / w, "y0": fb.y0 / h,
                    "x1": fb.x1 / w, "y1": fb.y1 / h,
                },
            })

        schema = {
            "source_pdf": self.annotations.pdf_path,
            "coordinate_system": "PDF points, origin top-left (PyMuPDF convention)",
            "pages": [
                {"page": p + 1, "fields": pages[p]}
                for p in sorted(pages)
            ],
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(schema, f, indent=2)
        self.status.config(text=f"Exported field schema to {path}")
        messagebox.showinfo("Export", f"Field schema written to:\n{path}")

    # --------------------------------------------------- Single extract ----
    def on_load_schema(self):
        path = filedialog.askopenfilename(
            filetypes=[("Field schema JSON", "*.json")])
        if not path:
            return
        try:
            from extraction import load_schema
            self._schema = load_schema(path)
        except Exception as e:
            messagebox.showerror("Load schema", f"Failed to load schema:\n{e}")
            return
        self._schema_path = path
        self.schema_path_var.set(path)
        n = sum(len(p.get("fields", []))
                for p in self._schema.get("pages", []))
        self.status.config(text=f"Loaded schema with {n} field(s).")

    def on_choose_filled_pdf(self):
        path = filedialog.askopenfilename(filetypes=[("PDF files", "*.pdf")])
        if not path:
            return
        self._filled_pdf_path = path
        self.filled_pdf_var.set(path)

    def on_run_extraction(self):
        if not self._schema:
            messagebox.showinfo("Extract", "Load a field schema first.")
            return
        if not self._filled_pdf_path:
            messagebox.showinfo("Extract", "Choose a filled PDF first.")
            return
        try:
            from extraction import extract_values
            self._last_results = extract_values(
                self._filled_pdf_path, self._schema)
        except Exception as e:
            messagebox.showerror("Extract", f"Extraction failed:\n{e}")
            return

        for item in self.result_tree.get_children():
            self.result_tree.delete(item)
        for name, r in self._last_results.items():
            tag = "high" if r["confidence"] >= 0.9 else "low"
            self.result_tree.insert(
                "", tk.END,
                values=(name, r["value"],
                        f"{r['confidence']:.2f}", r["source"]),
                tags=(tag,),
            )
        self.extract_export_btn.config(state=tk.NORMAL)
        self.status.config(
            text=f"Extracted {len(self._last_results)} field(s) from "
            f"{os.path.basename(self._filled_pdf_path)}")

    def on_export_extracted(self):
        if not self._last_results:
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".json",
            filetypes=[("Extracted JSON", "*.json")],
            initialfile="extracted_values.json",
        )
        if not path:
            return
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self._last_results, f, indent=2)
        self.status.config(text=f"Exported extracted values to {path}")

    # ---------------------------------------------------- Bulk handlers ----
    def on_bulk_pick_zips(self):
        paths = filedialog.askopenfilenames(
            filetypes=[("ZIP archives", "*.zip")])
        if not paths:
            return
        seen = set(self._bulk_zip_paths)
        for p in paths:
            if p not in seen:
                self._bulk_zip_paths.append(p)
                seen.add(p)
        self._refresh_bulk_zip_label()

    def on_bulk_clear_zips(self):
        self._bulk_zip_paths.clear()
        self._refresh_bulk_zip_label()

    def _refresh_bulk_zip_label(self):
        if not self._bulk_zip_paths:
            self.zip_list_var.set("(no ZIP files selected)")
        elif len(self._bulk_zip_paths) == 1:
            self.zip_list_var.set(self._bulk_zip_paths[0])
        else:
            self.zip_list_var.set(
                f"{len(self._bulk_zip_paths)} ZIPs: "
                + ", ".join(os.path.basename(p)
                            for p in self._bulk_zip_paths[:3])
                + ("…" if len(self._bulk_zip_paths) > 3 else ""))

    def on_bulk_add_schemas(self):
        paths = filedialog.askopenfilenames(
            filetypes=[("Schema JSON", "*.json")])
        if not paths:
            return
        for p in paths:
            base = os.path.splitext(os.path.basename(p))[0]
            label = base
            n = 2
            while label in self._schemas:
                label = f"{base} ({n})"
                n += 1
            new_label = simpledialog.askstring(
                "Schema label",
                f"Display label for:\n{p}",
                initialvalue=label,
                parent=self.root,
            )
            if not new_label or not new_label.strip():
                continue
            new_label = new_label.strip()
            if new_label in self._schemas:
                messagebox.showwarning(
                    "Duplicate label",
                    f"A schema named '{new_label}' is already loaded. Skipping.")
                continue
            try:
                with open(p, "r", encoding="utf-8") as f:
                    schema = json.load(f)
            except Exception as e:
                messagebox.showerror("Schema", f"Failed to load {p}:\n{e}")
                continue
            schema["_display_name"] = new_label
            self._schemas[new_label] = schema
            self._schema_paths[new_label] = p

        self._refresh_schemas_list()
        self._refresh_assign_combo()

    def on_bulk_clear_schemas(self):
        self._schemas.clear()
        self._schema_paths.clear()
        for row_id in list(self._bulk_assignments.keys()):
            if self._bulk_assignments[row_id] not in self._schemas:
                self._bulk_assignments[row_id] = None
        self._refresh_schemas_list()
        self._refresh_assign_combo()
        self._refresh_bulk_rows()

    def _refresh_schemas_list(self):
        if not self._schemas:
            self.schemas_list_var.set("(no schemas loaded)")
        else:
            names = list(self._schemas.keys())
            self.schemas_list_var.set(
                f"{len(names)}: " + ", ".join(names[:5])
                + ("…" if len(names) > 5 else ""))

    def _refresh_assign_combo(self):
        values = ["— none —"] + list(self._schemas.keys())
        self.bulk_assign_combo["values"] = values
        if self.bulk_assign_var.get() not in values:
            self.bulk_assign_var.set("— none —")

    def on_bulk_scan(self):
        if not self._bulk_zip_paths:
            messagebox.showinfo("Bulk", "Add at least one ZIP file first.")
            return

        from bulk_extractor import scan_zip

        self._bulk_entries.clear()
        self._bulk_assignments.clear()
        self._bulk_report = None
        self.bulk_export_btn.config(state=tk.DISABLED)
        self.bulk_detail_btn.config(state=tk.DISABLED)
        self.bulk_summary_lbl.config(text="")
        for item in self.bulk_tree.get_children():
            self.bulk_tree.delete(item)

        errors = []
        for zp in self._bulk_zip_paths:
            entries, summary = scan_zip(zp)
            if summary.status == "error":
                errors.append(f"{summary.archive}: {summary.error}")
                continue
            for i, e in enumerate(entries):
                row_id = f"{e.archive}\x1f{e.relative_path}\x1f{i}"
                self._bulk_entries.append({
                    "row_id": row_id,
                    "archive": e.archive,
                    "archive_path": e.archive_path,
                    "relative_path": e.relative_path,
                    "size_bytes": e.size_bytes,
                })
                self._bulk_assignments[row_id] = None

        self._refresh_bulk_rows()
        msg = f"Discovered {len(self._bulk_entries)} PDF(s)."
        if errors:
            msg += " Some archives failed — see below."
            for err in errors:
                messagebox.showwarning("Scan warnings", err)
        self.status.config(text=msg)

    def _refresh_bulk_rows(self):
        for item in self.bulk_tree.get_children():
            self.bulk_tree.delete(item)
        for e in self._bulk_entries:
            row_id = e["row_id"]
            schema_label = self._bulk_assignments.get(row_id) or "— none —"
            tags = () if self._bulk_assignments.get(row_id) else ("unassigned",)
            self.bulk_tree.insert(
                "", tk.END, iid=row_id,
                values=(e["archive"], e["relative_path"], schema_label,
                        f"{e['size_bytes'] / 1024:.0f}", ""),
                tags=tags)

    def on_bulk_row_double_click(self, event):
        row_id = self.bulk_tree.identify_row(event.y)
        if not row_id:
            return
        col = self.bulk_tree.identify_column(event.x)
        if col != "#3":
            return
        if not self._schemas:
            messagebox.showinfo(
                "Assign schema", "Load at least one schema first.")
            return
        current = self._bulk_assignments.get(row_id)
        win = tk.Toplevel(self.root)
        win.title("Assign schema")
        win.transient(self.root)
        win.grab_set()
        tk.Label(win, text="Pick a schema for:").pack(
            anchor="w", padx=10, pady=(10, 2))
        tk.Label(win,
                 text=f"{self.bulk_tree.set(row_id, 'archive')} / "
                 f"{self.bulk_tree.set(row_id, 'relative_path')}",
                 font=("TkDefaultFont", 9, "italic")).pack(anchor="w", padx=10)

        var = tk.StringVar(value=current or "— none —")
        ttk.Combobox(win, textvariable=var, state="readonly",
                     values=["— none —"] + list(self._schemas.keys()),
                     width=40).pack(padx=10, pady=10)

        def _apply():
            chosen = var.get()
            self._bulk_assignments[row_id] = None if chosen == "— none —" else chosen
            self._refresh_bulk_rows()
            win.destroy()

        btns = tk.Frame(win)
        btns.pack(pady=(0, 10))
        tk.Button(btns, text="OK", width=10, command=_apply).pack(
            side=tk.LEFT, padx=4)
        tk.Button(btns, text="Cancel", width=10,
                  command=win.destroy).pack(side=tk.LEFT, padx=4)

    def on_bulk_apply_to_selected(self):
        selected = self.bulk_tree.selection()
        if not selected:
            return
        chosen = self.bulk_assign_var.get()
        if chosen == "— none —":
            messagebox.showinfo(
                "Assign", "Choose a schema in the dropdown first.")
            return
        if chosen not in self._schemas:
            return
        for row_id in selected:
            self._bulk_assignments[row_id] = chosen
        self._refresh_bulk_rows()

    def on_bulk_clear_assignment(self):
        for row_id in self.bulk_tree.selection():
            self._bulk_assignments[row_id] = None
        self._refresh_bulk_rows()

    def on_bulk_extract(self):
        if not self._schemas:
            messagebox.showinfo("Extract", "Load at least one schema first.")
            return
        if not self._bulk_entries:
            messagebox.showinfo("Extract", "Scan ZIPs first to discover PDFs.")
            return

        assignments: Dict[Tuple[str, str], dict] = {}
        unassigned_count = 0
        for e in self._bulk_entries:
            label = self._bulk_assignments.get(e["row_id"])
            if not label or label not in self._schemas:
                unassigned_count += 1
                continue
            assignments[(e["archive"], e["relative_path"])
                        ] = self._schemas[label]

        if not assignments:
            messagebox.showinfo(
                "Extract",
                "No PDFs have been assigned a schema. Double-click a row's "
                "Schema cell to assign one.")
            return

        proceed = messagebox.askyesno(
            "Extract",
            f"Extract {len(assignments)} assigned PDF(s)?\n"
            f"{unassigned_count} unassigned PDF(s) will be skipped.")
        if not proceed:
            return

        from bulk_extractor import process_zips_with_assignments

        self.bulk_progress.config(value=0)
        self.status.config(text="Extracting…")
        self.bulk_export_btn.config(state=tk.DISABLED)
        self.bulk_detail_btn.config(state=tk.DISABLED)

        zip_paths = list(self._bulk_zip_paths)
        assignments_snapshot = dict(assignments)

        def _worker():
            try:
                report = process_zips_with_assignments(
                    zip_paths, assignments_snapshot,
                    progress_cb=lambda m: self.root.after(
                        0, lambda: self.status.config(text=m)),
                )
            except Exception as e:
                self.root.after(
                    0, lambda: messagebox.showerror("Bulk", f"{e}"))
                return
            self.root.after(0, self._bulk_finish, report)

        threading.Thread(target=_worker, daemon=True).start()

    def _bulk_finish(self, report):
        self._bulk_report = report
        ok = sum(1 for f in report.files if f.status == "ok")
        err = sum(1 for f in report.files if f.status == "error")
        unassigned = sum(1 for f in report.files if f.status ==
                         "skipped_unassigned")
        too_large = sum(1 for f in report.files if f.status ==
                        "skipped_too_large")

        status_by_key = {(f.archive, f.relative_path): f for f in report.files}
        for e in self._bulk_entries:
            row_id = e["row_id"]
            fr = status_by_key.get((e["archive"], e["relative_path"]))
            if fr is None or not self.bulk_tree.exists(row_id):
                continue
            tags = ()
            if fr.status == "error":
                tags = ("err",)
            elif fr.status == "skipped_unassigned":
                tags = ("unassigned",)
            self.bulk_tree.item(row_id, values=(
                e["archive"], e["relative_path"],
                self._bulk_assignments.get(row_id) or "— none —",
                f"{e['size_bytes'] / 1024:.0f}",
                fr.status,
            ), tags=tags)

        self.bulk_progress.config(value=100)
        self.bulk_export_btn.config(
            state=tk.NORMAL if report.files else tk.DISABLED)
        self.bulk_detail_btn.config(
            state=tk.NORMAL if report.files else tk.DISABLED)
        self.bulk_summary_lbl.config(
            text=f"{ok} ok · {err} errors · "
            f"{unassigned} skipped (unassigned) · {too_large} too large")
        self.status.config(text="Extraction complete.")

    def on_bulk_export(self):
        if not self._bulk_report:
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".json",
            filetypes=[("Bulk report JSON", "*.json")],
            initialfile="bulk_results.json",
        )
        if not path:
            return
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self._bulk_report.to_dict(), f, indent=2)
        self.status.config(text=f"Bulk report written to {path}")

    def on_bulk_view_selected(self):
        sel = self.bulk_tree.selection()
        if not sel or not self._bulk_report:
            return
        row_id = sel[0]
        entry = next(
            (e for e in self._bulk_entries if e["row_id"] == row_id), None)
        if entry is None:
            return
        fr = next((f for f in self._bulk_report.files
                   if f.archive == entry["archive"]
                   and f.relative_path == entry["relative_path"]), None)
        if fr is None:
            messagebox.showinfo("View", "No extraction result for this row.")
            return

        win = tk.Toplevel(self.root)
        win.title(f"{fr.archive} / {fr.relative_path}")
        win.geometry("700x500")
        txt = tk.Text(win, wrap="none", font=("Courier", 10))
        txt.pack(fill=tk.BOTH, expand=True)
        if fr.status != "ok":
            txt.insert("1.0",
                       f"Status: {fr.status}\nSchema: {fr.schema_name or '—'}\n"
                       f"Error: {fr.error or '(none)'}")
        else:
            txt.insert("1.0", json.dumps({
                "schema": fr.schema_name,
                "fields": fr.fields,
            }, indent=2))
        txt.config(state="disabled")


# ---------------------------------------------------------------------------
# CLI entry
# ---------------------------------------------------------------------------

def main():
    pdf_path = sys.argv[1] if len(sys.argv) > 1 else None
    root = tk.Tk()
    PDFAnnotator(root, pdf_path=pdf_path)
    root.mainloop()


if __name__ == "__main__":
    main()
