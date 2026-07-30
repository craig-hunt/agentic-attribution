package generator

// Composite vocabularies produce titles that read like real catalog entries
// without pulling a licensed dataset. Titles matter because BM25 scoring and
// embedding quality both degrade against obviously synthetic text, and a demo
// that searches "Product 12345" proves nothing about relevance tuning.

type category struct {
	ID        string
	Types     []string
	Modifiers []string
	Units     []string
}

var categories = []category{
	{
		ID:        "cat_electronics_audio",
		Types:     []string{"Wireless Earbuds", "Over-Ear Headphones", "Bluetooth Speaker", "Soundbar", "Studio Monitor", "Portable DAC"},
		Modifiers: []string{"Noise Cancelling", "Hi-Res", "Waterproof", "Low Latency", "Open-Back", "Bass Boost"},
		Units:     []string{"40mm Driver", "50mm Driver", "30h Battery", "24-Bit", "aptX HD"},
	},
	{
		ID:        "cat_electronics_power",
		Types:     []string{"Portable Charger", "Wall Adapter", "Car Charger", "Charging Station", "Power Bank", "Surge Protector"},
		Modifiers: []string{"Fast Charge", "GaN", "Multi-Port", "Foldable", "Magnetic", "PD 3.0"},
		Units:     []string{"10000mAh", "20000mAh", "65W", "100W", "140W", "30W"},
	},
	{
		ID:        "cat_computing",
		Types:     []string{"Mechanical Keyboard", "Wireless Mouse", "USB-C Hub", "Docking Station", "Monitor Arm", "Laptop Stand"},
		Modifiers: []string{"Hot-Swappable", "Low-Profile", "Ergonomic", "Aluminum", "Dual-Display", "Adjustable"},
		Units:     []string{"75%", "TKL", "Full-Size", "8K Polling", "Thunderbolt 4", "4K 120Hz"},
	},
	{
		ID:        "cat_home_kitchen",
		Types:     []string{"Espresso Machine", "Pour-Over Kettle", "Burr Grinder", "Cast Iron Skillet", "Chef Knife", "Stand Mixer"},
		Modifiers: []string{"Variable Temperature", "Conical", "Pre-Seasoned", "Hand-Forged", "Dual Boiler", "Tilt-Head"},
		Units:     []string{"1.7L", "58mm", "8-Inch", "10-Inch", "5-Quart", "40 Grind Settings"},
	},
	{
		ID:        "cat_outdoor",
		Types:     []string{"Trail Running Shoes", "Insulated Jacket", "Hiking Daypack", "Trekking Poles", "Headlamp", "Sleeping Pad"},
		Modifiers: []string{"Gore-Tex", "Packable", "Rechargeable", "Carbon Fiber", "Ripstop", "Ultralight"},
		Units:     []string{"20L", "28L", "800-Fill", "R-Value 4.2", "400 Lumen", "6mm Drop"},
	},
	{
		ID:        "cat_pet",
		Types:     []string{"Dog Paw Mat", "Orthopedic Dog Bed", "Slow Feeder Bowl", "Retractable Leash", "Pet Stain Remover", "Grooming Brush"},
		Modifiers: []string{"Machine Washable", "Non-Slip", "Memory Foam", "Enzyme-Based", "Self-Cleaning", "Quick-Dry"},
		Units:     []string{"30x20 in", "36x27 in", "Large", "Medium", "32 oz", "1 Gallon"},
	},
	{
		ID:        "cat_office",
		Types:     []string{"Standing Desk", "Task Chair", "Desk Lamp", "Cable Tray", "Whiteboard", "Footrest"},
		Modifiers: []string{"Electric", "Lumbar Support", "Dimmable", "Under-Desk", "Magnetic", "Contoured"},
		Units:     []string{"48-Inch", "60-Inch", "Dual Motor", "5000K", "3-Stage"},
	},
	{
		ID:        "cat_fitness",
		Types:     []string{"Adjustable Dumbbells", "Resistance Bands", "Yoga Mat", "Kettlebell", "Foam Roller", "Jump Rope"},
		Modifiers: []string{"Quick-Adjust", "Latex-Free", "Extra Thick", "Powder-Coated", "High-Density", "Weighted"},
		Units:     []string{"5-52 lb", "6mm", "8mm", "35 lb", "18-Inch", "Set of 5"},
	},
}

var brands = []string{
	"Northgate", "Verity", "Ridgeline", "Halcyon", "Kestrel", "Bramble",
	"Ironwood", "Solstice", "Meridian", "Larkspur", "Onyx Field", "Copperline",
	"Thornbury", "Vantage", "Bluecrest", "Perigee", "Ashford", "Windrow",
	"Quarrystone", "Fernhill", "Alder & Pine", "Stonebridge", "Highmark", "Cobalt Row",
}

var colors = []string{
	"Black", "Slate", "Graphite", "Ivory", "Sand", "Navy",
	"Forest", "Charcoal", "Sage", "Rust", "Bone", "Midnight",
}

// Merchant naming produces recognizable retailer archetypes so the demo's
// merchant dimension reads plausibly in the dashboard.
var merchantPrefixes = []string{
	"Summit", "Harbor", "Meadow", "Crossroads", "Beacon", "Lantern",
	"Foundry", "Junction", "Wildwood", "Anchor", "Grove", "Trellis",
}

var merchantSuffixes = []string{
	"Supply Co", "Outfitters", "Mercantile", "Trading Post", "Goods",
	"Direct", "Marketplace", "Depot", "Emporium", "Provisions",
}

var publisherNames = []string{
	"Gear Digest", "The Honest Review", "Everyday Carry Weekly", "Trailhead Notes",
	"Kitchen Bench", "Desk Setup Daily", "Paws & Claws Reviews", "Signal Boost",
	"The Shortlist", "Field Tested", "Buyer's Compass", "Considered",
}

// Merchant feeds drift. The same product arrives with a differently formatted
// title from each merchant, which is exactly the normalization burden the
// ingest pipeline exists to absorb.
var titleDriftTemplates = []string{
	"%s %s",             // Brand Title
	"%s - %s",           // Brand - Title
	"%s | %s",           // Brand | Title
	"%s %s - Brand New", // Brand Title - Brand New
	"%s %s (Free Ship)", // Brand Title (Free Ship)
	"NEW %s %s",         // NEW Brand Title
}
