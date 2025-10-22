const axios = require("axios");

axios.get("http://localhost:5000/api/users")
  .then(res => console.log(res.data))
  .catch(err => console.error("Error:", err.message));
