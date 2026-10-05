import numpy as np
# กลมกลืนหลอกระบบ: ถ้าไลบรารีตัวไหนมองหาคำสั่งเก่า np.long ให้มันวิ่งมาใช้ np.int64 แทนซะเลย!
if not hasattr(np, 'long'):
    np.long = np.int64
